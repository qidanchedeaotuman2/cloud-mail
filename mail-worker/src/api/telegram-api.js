import app from '../hono/hono';
import telegramService from '../service/telegram-service';

app.get('/telegram/getEmail/:token', async (c) => {
    const content = await telegramService.getEmailContent(c, c.req.param());
    c.header('Cache-Control', 'public, max-age=604800, immutable');
    return c.html(content)
});

// 👇 新增的可视化写信面板网页入口 (给 Telegram Web App 用的)
app.get('/telegram/webapp', async (c) => {
    return await telegramService.renderWebApp(c);
});

// 👇 接收 TG 消息的 Webhook 路由入口
app.post('/telegram/webhook', async (c) => {
    return await telegramService.handleWebhook(c);
});
