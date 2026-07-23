import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';

// ==========================================
// 🚀 新增：企业微信卡片推送引擎
// ==========================================
async function sendWechatCard(env, params) {
    // 如果环境变量里没配企微 Webhook，直接跳过不执行
    if (!env.WECHAT_WEBHOOK) return;

    // 直接从邮件解析好的 params 里拿数据
    const subject = params.subject || "无标题";
    const from = params.sendEmail || "未知发件人";
    const to = params.toEmail || "未知收件人";

    const payload = {
        msgtype: "textcard",
        textcard: {
            title: "📩 收到新邮件",
            description: `<div class="gray">发件人：${from}</div><div class="normal">主题：${subject}</div><div class="highlight">收件人：${to}</div>`,
            url: "https://mail.orzz.cc.cd", // 如果你的域名变了，这里记得改成最新的网页后台地址
            btntxt: "打开邮箱查看"
        }
    };

    try {
        await fetch(env.WECHAT_WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error("企微推送失败:", e);
    }
}
// ==========================================

export async function email(message, env, ctx) {

    try {

        const {
            receive,
            tgChatId,
            tgBotStatus,
            forwardStatus,
            forwardEmail,
            ruleEmail,
            ruleType,
            r2Domain,
            noRecipient
        } = await settingService.query({ env });

        if (receive === settingConst.receive.CLOSE) {
            message.setReject('Service suspended');
            return;
        }

        const reader = message.raw.getReader();
        let content = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            content += new TextDecoder().decode(value);
        }

        const email = await PostalMime.parse(content);

        const account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

        if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
            message.setReject('Recipient not found');
            return;
        }

        let userRow = {}

        if (account) {
             userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
        }

        if (account && userRow.email !== env.admin) {

            let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

            if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
                message.setReject('The recipient is not authorized to use this domain.');
                return;
            }

            if(roleService.isBanEmail(banEmail, email.from.address)) {
                message.setReject('The recipient is disabled from receiving emails.');
                return;
            }

        }

        if (!email.to) {
            email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
        }

        const toName = email.to.find(item => item.address === message.to)?.name || '';

        const params = {
            toEmail: message.to,
            toName: toName,
            sendEmail: email.from.address,
            name: email.from.name || emailUtils.getName(email.from.address),
            subject: email.subject,
            content: email.html,
            text: email.text,
            cc: email.cc ? JSON.stringify(email.cc) : '[]',
            bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
            recipient: JSON.stringify(email.to),
            inReplyTo: email.inReplyTo,
            relation: email.references,
            messageId: email.messageId,
            userId: account ? account.userId : 0,
            accountId: account ? account.accountId : 0,
            isDel: isDel.DELETE,
            status: emailConst.status.SAVING
        };

        const attachments = [];
        const cidAttachments = [];

        for (let item of email.attachments) {
            let attachment = { ...item };
            attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
            attachment.size = item.content.length ?? item.content.byteLength;
            attachments.push(attachment);
            if (attachment.contentId) {
                cidAttachments.push(attachment);
            }
        }

        let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

        attachments.forEach(attachment => {
            attachment.emailId = emailRow.emailId;
            attachment.userId = emailRow.userId;
            attachment.accountId = emailRow.accountId;
        });

        try {
            if (attachments.length > 0) {
                await attService.addAtt({ env }, attachments);
            }
        } catch (e) {
            console.error(e);
        }

        emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);


        if (ruleType === settingConst.ruleType.RULE) {

            const emails = ruleEmail.split(',');

            if (!emails.includes(message.to)) {
                return;
            }

        }

        //转发到TG
        if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
            await telegramService.sendEmailToBot({ env }, emailRow)
        }

        // ==========================================
        // 🚀 新增：并发推送到企业微信
        // ==========================================
        ctx.waitUntil(sendWechatCard(env, params));


        //转发到其他邮箱
        if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

            const emails = forwardEmail.split(',');

            await Promise.all(emails.map(async email => {

                try {
                    await message.forward(email);
                } catch (e) {
                    console.error(`转发邮箱 ${email} 失败：`, e);
                }

            }));

        }

    } catch (e) {
        console.error('邮件接收异常: ', e);
        throw e
    }
}
