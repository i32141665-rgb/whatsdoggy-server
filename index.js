import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('⚡ Новый QR-код сгенерирован!');
            const qrImageUrl = await qrcode.toDataURL(qr);
            io.emit('qr', { qr: qrImageUrl });
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp успешно подключен!');
            io.emit('ready');
        } else if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Соединение закрыто. Переподключение:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        }
    });

    // Прием входящих сообщений из WhatsApp
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const fromJid = msg.key.remoteJid;
            if (!fromJid || fromJid.includes('@g.us') || fromJid.includes('@broadcast') || fromJid.includes('@lid')) {
                continue;
            }

            const cleanPhone = fromJid.split('@')[0].split(':')[0].replace(/\D/g, '');
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            io.emit('message', {
                from: cleanPhone,
                text: text,
                type: 'text'
            });
        }
    });
}

// Прием отправки из браузера
io.on('connection', (socket) => {
    console.log('🔌 Браузер подключен к сокету');

    socket.on('send_message', async (data) => {
        try {
            console.log('📩 Получены данные от браузера:', data);

            const rawNumber = data.to || data.phone || data.number;
            const messageText = data.text || data.message;

            if (!rawNumber || !sock) {
                console.error('❌ Ошибка: не указан номер или сокет WA не готов!');
                return;
            }

            // 1. Очищаем номер до чистых цифр
            let cleanNumber = String(rawNumber).replace(/\D/g, '');

            // 2. Если номер начинается с 8 и длина 11 цифр — меняем на 7
            if (cleanNumber.startsWith('8') && cleanNumber.length === 11) {
                cleanNumber = '7' + cleanNumber.slice(1);
            }

            // 3. Запрашиваем у WhatsApp валидный JID и инициализируем E2EE сессию
            const results = await sock.onWhatsApp(cleanNumber);
            const userAccount = results && results[0];

            if (!userAccount || !userAccount.exists) {
                console.error(`❌ Номер ${cleanNumber} не найден в WhatsApp!`);
                socket.emit('error_msg', { message: 'Номер не зарегистрирован в WhatsApp' });
                return;
            }

            const recipientJid = userAccount.jid; // Это правильный JID вида 77767737216@s.whatsapp.net или с идентификатором устройства

            console.log(`🚀 Отправляем в WhatsApp на проверяемый JID: ${recipientJid} | Текст: "${messageText}"`);

            // 4. Отправка сообщения
            const sentMsg = await sock.sendMessage(recipientJid, { text: messageText });
            console.log('✅ Сообщение успешно отправлено в WhatsApp!', sentMsg?.key);

        } catch (error) {
            console.error('❌ Ошибка при реальной отправке в WhatsApp:', error);
        }
    });
});

connectToWhatsApp();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер WhatsDoggy запущен на порту ${PORT}`));
