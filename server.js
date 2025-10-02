// backend/server.js

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://ton-frontend.onrender.com', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
  },
});

app.use(cors());

let gameState = {
  players: [],
  currentPlayerIndex: 0,
  drawDeck: [],
  discardDeck: [],
};

function initializeGame() {
  // Logique d'initialisation du jeu
}

io.on('connection', (socket) => {
  console.log(`Nouveau joueur connecté : ${socket.id}`);

  // Ajouter le joueur au jeu
  gameState.players.push({ id: socket.id, name: `Joueur ${socket.id.slice(0, 5)}`, hand: [] });

  // Initialiser le jeu si nécessaire
  if (gameState.players.length === 2) {
    initializeGame();
  }

  // Envoyer l'état du jeu au nouveau joueur
  socket.emit('gameState', gameState);

  // Gérer les événements de jeu
  socket.on('playCard', (cardIndex) => {
    // Logique pour jouer une carte
  });

  socket.on('drawCard', () => {
    // Logique pour piocher une carte
  });

  socket.on('disconnect', () => {
    console.log(`Joueur déconnecté : ${socket.id}`);
    // Logique pour gérer la déconnexion
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur en écoute sur le port ${PORT}`);
});
