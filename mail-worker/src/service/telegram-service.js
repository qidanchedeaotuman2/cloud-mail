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

    // 新增的接收指令并发信的模块
    async handleWebhook(c) {
        try {
            const body = await c.req.json();
            const message = body.message;

            if (!message || !message.text) {
                return c.text('OK');
            }

            const settings = await settingService.query(c);
            const { tgChatId, tgBotToken, customDomain } = settings;
            const resendKey = settings.resendApiKey || settings.resendToken || settings.resendKey;

            const allowedChatIds = tgChatId.split(',');
            const incomingChatId = String(message.chat.id);

            // 白名单校验，非授权用户直接拦截
            if (!allowedChatIds.includes(incomingChatId)) {
                console.log(`⛔ 拦截到陌生人请求，Chat ID: ${incomingChatId}`);
                return c.text('OK');
            }

            const text = message.text;
            
            // 解析并发信的核心逻辑
            if (text.startsWith('/send ')) {
                const parts = text.split(' ');

                if (parts.length < 5) {
                    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: incomingChatId,
                            text: "❌ 格式错误！请使用新格式：\n/send 发件别名 收件人邮箱 标题 正文\n\n💡 举个栗子：\n/send info zhangsan@qq.com 合作意向 附件已发送。"
                        })
                    });
                    return c.text('OK');
                }

                let fromInput = parts[1];
                let fromAddress = fromInput.includes('@') ? fromInput : `${fromInput}@${customDomain}`;
                const toEmail = parts[2];
                const subject = parts[3];
                const emailBody = parts.slice(4).join(' ');

                if (!resendKey) {
                    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: incomingChatId, text: "❌ 发生错误：系统后台未配置 Resend 密钥" })
                    });
                    return c.text('OK');
                }

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
