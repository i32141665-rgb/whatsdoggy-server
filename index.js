import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { MongoClient } from 'mongodb';
import qrcode from 'qrcode';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Базовый маршрут для проверки работы
app.get('/', (req, res) => {
  res.send('WhatsDoggy Server is running!');
});

// Переменная для хранения состояния подключения Baileys
let sock = null;
let qrCodeData = null;

// Функция запуска WhatsApp клиента
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
      qrCodeData = await qrcode.toDataURL(qr);
      console.log('New QR Code generated');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connected successfully!');
      qrCodeData = null;
    }
  });
}

// Маршрут для получения QR-кода через веб-интерфейс / Socket.io при необходимости
app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.send(`<img src="${qrCodeData}" alt="Scan QR Code"/>`);
  } else {
    res.send('QR Code not ready or already connected.');
  }
});

// Запуск клиента WhatsApp
connectToWhatsApp().catch(err => console.log('WhatsApp connection error:', err));

// Обязательный порт для работы на Render (или 3000 локально)
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
 
