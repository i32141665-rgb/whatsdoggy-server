const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Раздаем статические файлы (если ваш HTML лежит в той же папке)
app.use(express.static(__dirname));

let sock;
let currentQr = null;

async function connectToWhatsApp() {
    // Сохранение сессии в папке auth_info
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Отключаем лишний шум в логах
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Если пришел текстовый QR-код, конвертируем его в картинку Data URL
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
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Соединение закрыто. Переподключение:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Сессия завершена (Logged out). Удалите папку auth_info для нового входа.');
            }
        }
    });

    // Обработка входящих сообщений
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const senderPhone = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            let messageText = '';
            let messageType = 'text';

            if (msg.message?.conversation) {
                messageText = msg.message.conversation;
            } else if (msg.message?.extendedTextMessage) {
                messageText = msg.message.extendedTextMessage.text;
            }

            // Отправляем сообщение на клиент через Socket.io
            io.emit('message', {
                from: senderPhone,
                text: messageText,
                type: messageType
            });
        }
    });
}

// WebSocket соединения с фронтендом
io.on('connection', (socket) => {
    console.log('Клиент подключился по WebSocket');

    // Если QR уже был сгенерирован ранее, сразу отправляем его новому клиенту
    if (currentQr) {
        socket.emit('qr', { qr: currentQr });
    } else if (sock && sock.user) {
        socket.emit('ready');
    }

    // Запрос контактов
    socket.on('get_contacts', async () => {
        try {
            // Пример отправки заглушки контактов или реальных чатов Baileys
            const contactsList = [
                { name: 'Тестовый друг', phone: '12345' }
            ];
            socket.emit('contacts', contactsList);
        } catch (e) {
            console.error('Ошибка получения контактов:', e);
        }
    });

    // Отправка сообщения пользователю
    socket.on('send_message', async (data) => {
        try {
            const jid = data.to.includes('@') ? data.to : `${data.to}@s.whatsapp.net`;
            if (data.type === 'image') {
                // Отправка картинки по Base64
                const buffer = Buffer.from(data.text.split(',')[1], 'base64');
                await sock.sendMessage(jid, { image: buffer });
            } else if (data.type === 'audio') {
                const buffer = Buffer.from(data.text.split(',')[1], 'base64');
                await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true });
            } else {
                await sock.sendMessage(jid, { text: data.text });
            }
        } catch (error) {
            console.error('Ошибка отправки сообщения:', error);
        }
    });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    connectToWhatsApp();
});
