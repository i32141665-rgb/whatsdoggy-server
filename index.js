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
const io = new Server(server);

app.use(express.static(__dirname));

let sock;
let currentQr = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
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
            console.log('WhatsDoggy успешно подключен к WhatsApp!');
            currentQr = null;
            io.emit('ready');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const remoteJid = msg.key.remoteJid;
            if (remoteJid.includes('@lid')) return;

            const senderPhone = remoteJid.replace('@s.whatsapp.net', '');
            let messageText = '';
            let messageType = 'text';

            if (msg.message?.conversation) {
                messageText = msg.message.conversation;
            } else if (msg.message?.extendedTextMessage) {
                messageText = msg.message.extendedTextMessage.text;
            } else if (msg.message?.audioMessage) {
                messageType = 'audio';
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    messageText = `data:audio/ogg;base64,${buffer.toString('base64')}`;
                } catch (e) {
                    console.error('Ошибка загрузки аудио:', e);
                }
            } else if (msg.message?.imageMessage) {
                messageType = 'image';
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    messageText = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                } catch (e) {
                    console.error('Ошибка загрузки фото:', e);
                }
            }

            io.emit('message', {
                from: senderPhone,
                text: messageText,
                type: messageType
            });
        }
    });
}

io.on('connection', (socket) => {
    if (currentQr) {
        socket.emit('qr', { qr: currentQr });
    } else if (sock && sock.user) {
        socket.emit('ready');
    }

    socket.on('get_contacts', async () => {
        try {
            if (sock && sock.store && sock.store.contacts) {
                const contactsArr = Object.values(sock.store.contacts).map(c => ({
                    name: c.name || c.notify || c.id.replace('@s.whatsapp.net', ''),
                    phone: c.id.replace('@s.whatsapp.net', '')
                }));
                socket.emit('contacts', contactsArr);
            } else {
                socket.emit('contacts', []);
            }
        } catch (e) {
            socket.emit('contacts', []);
        }
    });

    // Обработка отправки с проверкой через onWhatsApp для точного JID казахстанских номеров
    socket.on('send_message', async (data) => {
        try {
            let cleanTo = data.to.replace(/\D/g, '').trim();
            if (cleanTo.startsWith('8') && cleanTo.length === 11) {
                cleanTo = '7' + cleanTo.slice(1);
            } else if (cleanTo.length === 10) {
                cleanTo = '7' + cleanTo;
            }

            // Проверяем через WhatsApp, зарегистрирован ли номер
            const [result] = await sock.onWhatsApp(cleanTo);
            const jid = result && result.exists ? result.jid : `${cleanTo}@s.whatsapp.net`;

            if (data.type === 'image') {
                const buffer = Buffer.from(data.text.split(',')[1], 'base64');
                await sock.sendMessage(jid, { image: buffer });
            } else if (data.type === 'audio') {
                const buffer = Buffer.from(data.text.split(',')[1], 'base64');
                // Отправляем как голосовое сообщение (ptt: true) с корректным pcm/mp4 контейнером
                await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
            } else {
                await sock.sendMessage(jid, { text: data.text });
            }
            console.log('Успешно отправлено на:', jid);
        } catch (error) {
            console.error('Ошибка отправки сообщения:', error);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    connectToWhatsApp();
});
