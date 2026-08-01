import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import qrcode from 'qrcode';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(__dirname));

let sock = null;
let currentQr = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["WhatsDoggy Web", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                currentQr = await qrcode.toDataURL(qr);
                io.emit('qr', { qr: currentQr });
            } catch (err) {
                console.error('Ошибка генерации QR:', err);
            }
        }

        if (connection === 'open') {
            console.log('WhatsDoggy успешно подключен к сети WhatsApp!');
            currentQr = null;
            io.emit('ready');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Соединение закрыто. Переподключение: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;
            if (msg.key.fromMe) return;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid || remoteJid.includes('@lid') || remoteJid.includes('@g.us')) return;

            const senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
            let messageText = '';
            let messageType = 'text';

            if (msg.message?.conversation) {
                messageText = msg.message.conversation;
            } else if (msg.message?.extendedTextMessage) {
                messageText = msg.message.extendedTextMessage.text;
            } else if (msg.message?.audioMessage) {
                messageType = 'audio';
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                messageText = `data:audio/mp3;base64,${buffer.toString('base64')}`;
            } else if (msg.message?.imageMessage) {
                messageType = 'image';
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                messageText = `data:image/jpeg;base64,${buffer.toString('base64')}`;
            }

            if (messageText) {
                io.emit('message', {
                    from: senderPhone,
                    text: messageText,
                    type: messageType
                });
            }
        } catch (err) {
            console.error('Ошибка при обработке входящего сообщения:', err);
        }
    });
} // <--- ВОТ ЗДЕСЬ НЕ ХВАТАЛО СКОБКИ

io.on('connection', (socket) => {
    if (currentQr) {
        socket.emit('qr', { qr: currentQr });
    } else if (sock && sock.user) {
        socket.emit('ready');
    }

    // НАДЕЖНАЯ ОТПРАВКА СООБЩЕНИЙ
    socket.on('send_message', async (data) => {
        if (!sock) {
            console.error('Ошибка: Сокет WhatsApp не инициализирован!');
            return;
        }

        try {
            // Очищаем номер от всего кроме цифр
            let cleanPhone = String(data.to).replace(/\D/g, '').trim();

            if (cleanPhone.startsWith('8') && cleanPhone.length === 11) {
                cleanPhone = '7' + cleanPhone.slice(1);
            } else if (cleanPhone.length === 10) {
                cleanPhone = '7' + cleanPhone;
            }

            // Формируем чистый JID
            const jid = `${cleanPhone}@s.whatsapp.net`;

            if (data.type === 'image') {
                const base64Data = data.text.replace(/^data:image\/\w+;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');
                await sock.sendMessage(jid, { image: buffer, caption: '' });
            } else if (data.type === 'audio') {
                const base64Data = data.text.replace(/^data:audio\/\w+;base64,/, '');
                const buffer = Buffer.from(base64Data, 'base64');
                await sock.sendMessage(jid, {
                    audio: buffer,
                    mimetype: 'audio/mp3',
                    ptt: false
                });
            } else {
                await sock.sendMessage(jid, { text: data.text });
            }

            console.log(`[УСПЕХ] Сообщение типа ${data.type} доставлено на ${jid}`);
        } catch (error) {
            console.error('Ошибка отправки в WhatsApp:', error);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер WhatsDoggy запущен на порту ${PORT}`);
    connectToWhatsApp();
});
