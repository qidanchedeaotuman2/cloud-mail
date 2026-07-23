import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import { eq } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import verifyUtils from '../utils/verify-utils';

const telegramService = {

    async getEmailContent(c, params) {
        const { token } = params;
        const result = await jwtUtils.verifyToken(c, token);
        if (!result) return emailTextTemplate('Access denied');
        const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();
        if (emailRow) {
            if (emailRow.content) {
                const { r2Domain } = await settingService.query(c);
                return emailHtmlTemplate(emailRow.content || '', r2Domain);
            } else {
                return emailTextTemplate(emailRow.text || '');
            }
        } else {
            return emailTextTemplate('The email does not exist');
        }
    },

    async sendEmailToBot(c, email) {
        // ==========================================
        // 1. 原有收取邮件转发给 TG 的逻辑（原封不动保留）
        // ==========================================
        const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);
        const tgChatIds = tgChatId.split(',');
        const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId });
        // 为了安全起见，这里也加上 https:// 的强制保障
        let safeDomain = customDomain.startsWith('http') ? customDomain : `https://${customDomain}`;
        const webAppUrl = customDomain ? `${safeDomain}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404';

        await Promise.all(tgChatIds.map(async chatId => {
            try {
                await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        parse_mode: 'HTML',
                        text: emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText),
                        reply_markup: { inline_keyboard: [[{ text: '查看', web_app: { url: webAppUrl } }]] }
                    })
                });
            } catch (e) {}
        }));

        // ==========================================
        // 2. 新增：企业微信 自建应用（瓦力） 双重推送逻辑
        // ==========================================
        try {
            const corpId = c.env && c.env.WECHAT_CORPID;
            const secret = c.env && c.env.WECHAT_SECRET;
            const agentId = c.env && c.env.WECHAT_AGENTID;
            const toUser = (c.env && c.env.WECHAT_TOUSER) || '@all';

            if (corpId && secret && agentId) {
                // 第一步：请求 Access Token
                const tokenRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`);
                const tokenData = await tokenRes.json();

                if (tokenData.errcode === 0 && tokenData.access_token) {
                    const safeSubject = email.subject || '无主题';
                    const safeFrom = email.from || '未知发件人';
                    const safeTo = email.to || '未知收件人';
                    const textPreview = (email.text || '无纯文本正文').substring(0, 150).replace(/\n/g, '  ') + '...';

                    // 第二步：使用 Token 发送 Markdown 卡片
                    await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tokenData.access_token}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            touser: toUser,
                            msgtype: "markdown",
                            agentid: parseInt(agentId),
                            markdown: {
                                content: `<font color="info">**收到新邮件啦！**</font>\n> **发件：**<font color="comment">${safeFrom}</font>\n> **收件：**<font color="comment">${safeTo}</font>\n> **主题：**<font color="comment">${safeSubject}</font>\n\n**内容预览：**\n${textPreview}\n\n[前往查看完整邮件网页](${webAppUrl})`
                            }
                        })
                    });
                }
            }
        } catch (wechatErr) {
            // 静默处理错误，不影响 TG
        }
    },

    async renderWebApp(c) {
        const settings = await settingService.query(c);
        const resendTokens = settings.resendTokens || {};
        const domains = Object.keys(resendTokens);
        if (domains.length === 0) domains.push('未配置域名');

        const optionsHtml = domains.map(d => `<option value="${d}">${d}</option>`).join('');

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <script src="https://telegram.org/js/telegram-web-app.js"></script>
            <style>
                body { font-family: sans-serif; padding: 20px; color: var(--tg-theme-text-color); background: var(--tg-theme-bg-color); margin: 0; }
                .form-group { margin-bottom: 15px; }
                label { display: block; font-weight: bold; font-size: 14px; margin-bottom: 5px; color: var(--tg-theme-hint-color); }
                input, textarea, select { width: 100%; box-sizing: border-box; padding: 12px; border: 1px solid var(--tg-theme-hint-color); border-radius: 8px; background: var(--tg-theme-bg-color); color: var(--tg-theme-text-color); font-size: 16px; outline: none; }
                input:focus, textarea:focus, select:focus { border-color: var(--tg-theme-button-color); }
                .email-prefix-group { display: flex; align-items: center; gap: 10px; }
                .email-prefix-group input { flex: 1; margin-bottom: 0; }
                .email-prefix-group select { flex: 1.2; margin-bottom: 0; }
                button { width: 100%; padding: 14px; background: var(--tg-theme-button-color); color: var(--tg-theme-button-text-color); border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 10px; transition: opacity 0.2s; }
                button:active { opacity: 0.7; }
            </style>
        </head>
        <body>
            <div class="form-group">
                <label>发件邮箱</label>
                <div class="email-prefix-group">
                    <input type="text" id="prefix" placeholder="别名(如: sky)" />
                    <span style="font-size: 18px; font-weight: bold;">@</span>
                    <select id="domain">${optionsHtml}</select>
                </div>
            </div>
            <div class="form-group">
                <label>收件人</label>
                <input type="email" id="toEmail" placeholder="例如: 123@qq.com" />
            </div>
            <div class="form-group">
                <label>邮件标题</label>
                <input type="text" id="subject" placeholder="输入标题" />
            </div>
            <div class="form-group">
                <label>邮件正文</label>
                <textarea id="content" rows="6" placeholder="输入你想发送的内容..."></textarea>
            </div>
            <button onclick="sendData()">🚀 立即发送邮件</button>

            <script>
                let tg = window.Telegram.WebApp;
                tg.expand();
                tg.ready();

                function sendData() {
                    let prefix = document.getElementById('prefix').value || 'admin';
                    let domain = document.getElementById('domain').value;
                    let toEmail = document.getElementById('toEmail').value;
                    let subject = document.getElementById('subject').value;
                    let content = document.getElementById('content').value;

                    if(!toEmail || !subject || !content) {
                        tg.showAlert('⚠️ 请填写完整的收件人、标题和正文！');
                        return;
                    }

                    let data = { action: 'send_email', fromAddress: prefix + '@' + domain, toEmail, subject, content };
                    tg.sendData(JSON.stringify(data));
                    tg.close();
                }
            </script>
        </body>
        </html>`;
        return c.html(html);
    },

    async handleWebhook(c) {
        try {
            const body = await c.req.json();
            const message = body.message;

            if (!message) return c.text('OK');

            const settings = await settingService.query(c);
            const { tgChatId, tgBotToken, resendTokens } = settings;
            const allowedChatIds = tgChatId.split(',');
            const incomingChatId = String(message.chat.id);

            if (!allowedChatIds.includes(incomingChatId)) return c.text('OK');

            // 1. 处理 Web App 传回来的数据
            if (message.web_app_data) {
                try {
                    const data = JSON.parse(message.web_app_data.data);
                    if (data.action === 'send_email') {
                        const { fromAddress, toEmail, subject, content } = data;
                        const fromDomain = fromAddress.split('@')[1];
                        const resendKey = resendTokens ? resendTokens[fromDomain] : null;

                        if (!resendKey) return c.text('OK'); // 防止报错

                        const sendRes = await fetch('https://api.resend.com/emails', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ from: fromAddress, to: toEmail, subject, text: content })
                        });

                        if (sendRes.ok) {
                            await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: incomingChatId, text: `✅ 网页发射成功！\n发件人: ${fromAddress}\n收件人: ${toEmail}` })
                            });
                        }
                    }
                } catch (e) {}
                return c.text('OK');
            }

            const text = message.text;
            if (!text) return c.text('OK');

            // 2. 如果发送的是完整快捷指令（保留备用）
            if (text.startsWith('/send ')) {
                const parts = text.split(' ');
                if (parts.length >= 5) {
                    let defaultDomain = Object.keys(resendTokens || {})[0] || '';
                    let fromInput = parts[1];
                    let fromAddress = fromInput.includes('@') ? fromInput : `${fromInput}@${defaultDomain}`;
                    const toEmail = parts[2];
                    const subject = parts[3];
                    const emailBody = parts.slice(4).join(' ');

                    const fromDomain = fromAddress.split('@')[1];
                    const resendKey = resendTokens ? resendTokens[fromDomain] : null;

                    if (resendKey) {
                        const sendRes = await fetch('https://api.resend.com/emails', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ from: fromAddress, to: toEmail, subject: subject, text: emailBody })
                        });
                        if (sendRes.ok) {
                            await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: incomingChatId, text: `✅ 快捷发信成功！\n收件人: ${toEmail}` })
                            });
                        }
                    }
                    return c.text('OK');
                }
            }

            // 3. 只有敲 /send 的时候，唤出小程序面板！
            if (text === '/send') {
                // 直接从当前请求中提取最准确的 URL，绝对包含 https://
                const currentUrl = new URL(c.req.url);
                const webAppUrl = currentUrl.origin + '/api/telegram/webapp';

                const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: incomingChatId,
                        text: "✨ 欢迎使用云邮发件面板！\n👇 请点击你的聊天输入框下方的【📝 打开写信面板】按钮！",
                        // 改为原生键盘！这样才能成功传递数据回服务器
                        reply_markup: {
                            keyboard: [[{ text: '📝 打开写信面板', web_app: { url: webAppUrl } }]],
                            resize_keyboard: true,
                            is_persistent: true
                        }
                    })
                });
                
                // 如果这次 Telegram 还敢报错，直接把错误怼在聊天框里抓现行！
                if (!res.ok) {
                    const err = await res.text();
                    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: incomingChatId, text: `⚠️ 按钮生成失败，错误原因：${err}` })
                    });
                }
            }
            return c.text('OK');
        } catch (error) {
            return c.text('OK');
        }
    }
};

export default telegramService;
