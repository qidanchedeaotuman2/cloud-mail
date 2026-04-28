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
import domainUtils from "../utils/domain-uitls";

const telegramService = {

    async getEmailContent(c, params) {

        const { token } = params

        const result = await jwtUtils.verifyToken(c, token);

        if (!result) {
            return emailTextTemplate('Access denied')
        }

        const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();

        if (emailRow) {

            if (emailRow.content) {
                const { r2Domain } = await settingService.query(c);
                return emailHtmlTemplate(emailRow.content || '', r2Domain)
            } else {
                return emailTextTemplate(emailRow.text || '')
            }

        } else {
            return emailTextTemplate('The email does not exist')
        }

    },

    async sendEmailToBot(c, email) {

        const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

        const tgChatIds = tgChatId.split(',');

        const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId })

        const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'

        await Promise.all(tgChatIds.map(async chatId => {
            try {
                const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        chat_id: chatId,
                        parse_mode: 'HTML',
                        text: emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText),
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '查看',
                                        web_app: { url: webAppUrl }
                                    }
                                ]
                            ]
                        }
                    })
                });
                if (!res.ok) {
                    console.error(`转发 Telegram 失败 status: ${res.status} response: ${await res.text()}`);
                }
            } catch (e) {
                console.error(`转发 Telegram 失败:`, e.message);
            }
        }));

    },

    async handleWebhook(c) {
        try {
            const body = await c.req.json();
            const message = body.message;

            if (!message || !message.text) {
                return c.text('OK');
            }

            // 1. 获取系统设置
            const settings = await settingService.query(c);
            const { tgChatId, tgBotToken, resendTokens } = settings;

            const allowedChatIds = tgChatId.split(',');
            const incomingChatId = String(message.chat.id);

            // 白名单拦截，不是自己的号坚决不理
            if (!allowedChatIds.includes(incomingChatId)) {
                return c.text('OK');
            }

            const text = message.text;
            
            // 核心发信指令解析
            if (text.startsWith('/send ')) {
                const parts = text.split(' ');

                if (parts.length < 5) {
                    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: incomingChatId,
                            text: "❌ 格式错误！请使用新格式：\n/send 发件别名 收件人邮箱 标题 正文"
                        })
                    });
                    return c.text('OK');
                }

                // 2. 智能获取正确的邮件域名
                // 直接从你的 Token 列表里提取你配置好的真实邮箱域名（比如 orzz.cc.cd）
                let defaultDomain = '';
                if (resendTokens && Object.keys(resendTokens).length > 0) {
                    defaultDomain = Object.keys(resendTokens)[0];
                }

                // 3. 处理发件人邮箱
                let fromInput = parts[1];
                // 防呆设计：如果只输入 sky，完美拼接成 sky@orzz.cc.cd
                let fromAddress = fromInput.includes('@') ? fromInput : `${fromInput}@${defaultDomain}`;
                
                const toEmail = parts[2];
                const subject = parts[3];
                // 拼接剩下的所有文本作为正文
                const emailBody = parts.slice(4).join(' ');

                // 4. 去 Token 列表里对暗号！提取后缀匹配对应的 API 密钥
                const fromDomain = fromAddress.split('@')[1]; 
                const resendKey = resendTokens ? resendTokens[fromDomain] : null;

                if (!resendKey) {
                    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: incomingChatId, text: `❌ 发生错误：系统找不到域名 [${fromDomain}] 的密钥！` })
                    });
                    return c.text('OK');
                }

                // 5. 万事俱备，请求 Resend 发射！
                try {
                    const sendRes = await fetch('https://api.resend.com/emails', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${resendKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            from: fromAddress,
                            to: toEmail,
                            subject: subject,
                            text: emailBody
                        })
                    });

                    if (sendRes.ok) {
                        await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: incomingChatId, text: `✅ 成功用 ${fromAddress} 发送邮件至：${toEmail}` })
                        });
                    } else {
                        const errorData = await sendRes.text();
                        await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: incomingChatId, text: `❌ 发送失败，Resend 报错：${errorData}` })
                        });
                    }
                } catch (err) {
                    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: incomingChatId, text: `❌ 接口请求异常：${err.message}` })
                    });
                }
            }

            return c.text('OK');
        } catch (error) {
            console.error(`处理 TG Webhook 失败:`, error.message);
            return c.text('OK');
        }
    }
}

export default telegramService
