import app from '../hono/hono';
import telegramService from '../service/telegram-service';

app.get('/telegram/getEmail/:token', async (c) => {
    const content = await telegramService.getEmailContent(c, c.req.param());
    c.header('Cache-Control', 'public, max-age=604800, immutable');
    return c.html(content)
});

// 👇 新增的接收 TG 消息的路由入口
app.post('/telegram/webhook', async (c) => {
    return await telegramService.handleWebhook(c);
});
