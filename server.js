const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// Déck UNO simplifié
function createDeck(){
  const colors=['red','green','blue','yellow'];
  const deck=[];
  colors.forEach(color=>{
    for(let i=0;i<=9;i++) deck.push({type:'number',color,value:i});
    deck.push({type:'draw2',color},{type:'reverse',color},{type:'skip',color});
  });
  for(let i=0;i<4;i++) deck.push({type:'draw4',color:'wild'});
  return shuffle(deck);
}

function shuffle(array){ return array.sort(()=>Math.random()-0.5); }

let game = {
  players: [],
  drawDeck: [],
  discardDeck: [],
  currentIndex:0,
  direction:1
};

// Ajouter un joueur
function addPlayer(id){
  const player={id,nick:'Joueur'+Math.floor(Math.random()*999),cards:[],isSpectator:false,hasCalledUno:false};
  game.players.push(player);
  if(game.drawDeck.length===0) startGame();
  return player;
}

// Supprimer joueur
function removePlayerById(id){
  game.players=game.players.filter(p=>p.id!==id);
  if(game.players.length>0 && game.currentIndex>=game.players.length) game.currentIndex=0;
}

// Distribuer cartes
function dealCards(player,count=7){
  for(let i=0;i<count;i++){
    if(game.drawDeck.length===0) reshuffleDiscard();
    player.cards.push(game.drawDeck.pop());
  }
}

// Reshuffle si deck vide
function reshuffleDiscard(){
  if(game.discardDeck.length<=1) return;
  const top = game.discardDeck.pop();
  game.drawDeck=shuffle(game.discardDeck);
  game.discardDeck=[top];
}

// État du jeu
function getGameState(){
  return {
    players: game.players.map(p=>({id:p.id,nick:p.nick,cardsCount:p.cards.length,isSpectator:p.isSpectator})),
    topCard: game.discardDeck[game.discardDeck.length-1] || {},
    drawDeckCount: game.drawDeck.length,
    currentPlayerId: game.players[game.currentIndex]?.id
  };
}

// Log à tous
function logAll(msg){ io.emit('log',msg); }

// Vérifier éliminations et restart
function checkEliminationsAndRestart(){
  game.players.forEach(p=>{
    if(!p.isSpectator && p.cards.length>35){
      p.isSpectator=true;
      logAll(`${p.nick} perd (plus de 35 cartes)`);
    }
  });
  const active = game.players.filter(p=>!p.isSpectator);
  if(active.length<=1){
    logAll(`Redémarrage partie...`);
    game.drawDeck=createDeck();
    game.discardDeck=[];
    game.players.forEach(p=>{
      p.cards=[];
      p.isSpectator=false;
      dealCards(p);
    });
    game.currentIndex=0;
    game.direction=1;
    io.emit('gameState', getGameState());
  }
}

// Démarrer partie
function startGame(){
  game.drawDeck=createDeck();
  game.discardDeck=[game.drawDeck.pop()];
  game.players.forEach(dealCards);
  game.currentIndex=0;
  game.direction=1;
  io.emit('gameState', getGameState());
}

// Jouer carte
function playCard(playerId, index, chosenColor){
  const player = game.players.find(p=>p.id===playerId);
  if(!player || player.isSpectator) return;
  const card = player.cards[index];
  if(!card) return;

  // Vérifier validité simple
  const top = game.discardDeck[game.discardDeck.length-1];
  if(card.color!==top.color && card.type!==top.type && card.color!=='wild') return;

  // Ne pas finir sur +2/+4
  if(player.cards.length===1 && (card.type==='draw2'||card.type==='draw4')) return;

  player.cards.splice(index,1);
  if(card.type==='wild' || card.type==='draw4') card.color=chosenColor;
  game.discardDeck.push(card);
  io.emit('cardPlayed',{playerId,card});
  logAll(`${player.nick} joue ${card.type} (${card.color})`);

  // Appliquer effets
  if(card.type==='reverse') game.direction*=-1;
  if(card.type==='skip') game.currentIndex = (game.currentIndex+game.direction+game.players.length)%game.players.length;
  if(card.type==='draw2' || card.type==='draw4'){
    const nextIndex = (game.currentIndex+game.direction+game.players.length)%game.players.length;
    const nextPlayer = game.players[nextIndex];
    const drawCount = card.type==='draw2'?2:4;
    for(let i=0;i<drawCount;i++) dealCards(nextPlayer,1);
    logAll(`${nextPlayer.nick} pioche ${drawCount} cartes !`);
  }

  game.currentIndex = (game.currentIndex+game.direction+game.players.length)%game.players.length;
  io.emit('gameState', getGameState());
  checkEliminationsAndRestart();
}

// Pioche
function drawOne(playerId){
  const player = game.players.find(p=>p.id===playerId);
  if(!player || player.isSpectator) return;
  if(game.drawDeck.length===0) reshuffleDiscard();
  if(game.drawDeck.length===0) return;
  const card = game.drawDeck.pop();
  player.cards.push(card);
  io.emit('cardDrawn',{playerId,card});
  logAll(`${player.nick} pioche une carte`);
  checkEliminationsAndRestart();
}

io.on('connection', socket=>{
  const player = addPlayer(socket.id);
  dealCards(player);
  socket.emit('gameState', getGameState());
  logAll(`${player.nick} rejoint la partie`);

  socket.on('setNick', ({nick})=>{
    player.nick=nick;
    logAll(`${player.id} définit son pseudo à ${nick}`);
    io.emit('gameState', getGameState());
  });

  socket.on('playCard', ({cardIndex, chosenColor})=>{
    playCard(socket.id, cardIndex, chosenColor);
  });

  socket.on('drawOne', ()=>{ drawOne(socket.id); });

  socket.on('callUno', ()=>{ logAll(`${player.nick} dit UNO !`); });

  socket.on('disconnect', ()=>{
    removePlayerById(socket.id);
    io.emit('gameState', getGameState());
    logAll(`${player.nick} quitte la partie`);
  });
});

// Bots automatiques (se déconnectent dès 2 joueurs humains)
setInterval(()=>{
  const humanPlayers = game.players.filter(p=>!p.isSpectator && !p.id.startsWith('bot'));

  // Ajouter bot si moins de 2 joueurs humains
  if(humanPlayers.length < 2){
    const botId='bot'+Math.floor(Math.random()*999);
    addPlayer(botId);
    logAll(`Bot ${botId} rejoint pour test`);
  }

  // Supprimer bots si 2+ joueurs humains
  if(humanPlayers.length >= 2){
    const bots = game.players.filter(p=>p.id.startsWith('bot'));
    bots.forEach(bot=>{
      removePlayerById(bot.id);
      logAll(`Bot ${bot.nick} quitte car 2+ joueurs humains`);
    });
  }

  // Tour des bots
  game.players.filter(p=>p.id.startsWith('bot')).forEach(bot=>{
    if(game.players[game.currentIndex].id===bot.id){
      if(bot.cards.length>0){
        playCard(bot.id, Math.floor(Math.random()*bot.cards.length), bot.cards[0].color);
      } else {
        drawOne(bot.id);
      }
    }
  });

},1500);

server.listen(PORT, ()=>console.log('UNO server listening on',PORT));
