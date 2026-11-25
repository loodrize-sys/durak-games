const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map(); // roomId -> { players: [], deck: [], table: [], trump: '', turn: 0, ... }

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    const deck = [];
    for (let s of SUITS) for (let r of RANKS) deck.push({ suit: s, rank: r, id: s + r });
    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function cardValue(card, trump) {
    const values = { '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
    let v = values[card.rank];
    if (card.suit === trump) v += 100;
    return v;
}

function canBeat(attackCard, defendCard, trump) {
    if (attackCard.suit === defendCard.suit) {
        return cardValue(defendCard, trump) > cardValue(attackCard, trump);
    }
    if (defendCard.suit === trump) return true;
    return false;
}

function startGame(room) {
    room.deck = createDeck();
    room.trump = room.deck[0].suit; // Last card is trump indicator
    room.players.forEach(p => p.hand = []);
    
    // Deal 6 cards each
    for (let i = 0; i < 6; i++) {
        room.players[0].hand.push(room.deck.pop());
        room.players[1].hand.push(room.deck.pop());
    }
    
    // Determine first turn: lowest trump
    let first = 0;
    let lowest = 999;
    room.players.forEach((p, idx) => {
        p.hand.forEach(c => {
            if (c.suit === room.trump && cardValue(c, room.trump) < lowest) {
                lowest = cardValue(c, room.trump);
                first = idx;
            }
        });
    });
    room.turn = first;
    room.table = [];
    room.phase = 'attack'; // 'attack' or 'defend'
    room.attacker = first;
    room.defender = 1 - first;
    room.transferred = false;
}

function broadcastRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.forEach((p, idx) => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
                type: 'state',
                you: idx,
                hand: p.hand,
                opponentCount: room.players[1 - idx]?.hand.length || 0,
                table: room.table,
                trump: room.trump,
                deckCount: room.deck.length,
                turn: room.turn,
                phase: room.phase,
                attacker: room.attacker,
                defender: room.defender,
                transferred: room.transferred
            }));
        }
    });
}

wss.on('connection', (ws) => {
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            
            if (data.type === 'create') {
                const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
                rooms.set(roomId, { id: roomId, players: [{ ws, hand: [] }, null], deck: [], table: [], trump: '', turn: 0, phase: 'waiting', transferred: false });
                ws.roomId = roomId;
                ws.send(JSON.stringify({ type: 'created', roomId }));
            }
            
            if (data.type === 'join') {
                const room = rooms.get(data.roomId);
                if (!room || room.players[1]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена или полна' }));
                    return;
                }
                room.players[1] = { ws, hand: [] };
                ws.roomId = data.roomId;
                startGame(room);
                broadcastRoom(data.roomId);
            }
            
            if (data.type === 'play') {
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const playerIdx = room.players.findIndex(p => p.ws === ws);
                if (playerIdx !== room.turn && room.phase !== 'attack') return; // Basic turn check
                
                const card = data.card;
                const hand = room.players[playerIdx].hand;
                const cardIdx = hand.findIndex(c => c.id === card.id);
                if (cardIdx === -1) return;
                
                if (room.phase === 'attack') {
                    // Attack
                    room.table.push({ attack: card, defend: null });
                    hand.splice(cardIdx, 1);
                    room.phase = 'defend';
                    room.turn = 1 - playerIdx;
                } else if (room.phase === 'defend') {
                    // Defend or Translate
                    const lastAttack = room.table.find(t => !t.defend);
                    if (!lastAttack) return;
                    
                    if (data.translate && !room.transferred) {
                        // Translation logic: only if first card, same rank
                        if (room.table.length === 1 && room.table[0].attack.rank === card.rank && !room.table[0].defend) {
                            room.table.push({ attack: card, defend: null });
                            hand.splice(cardIdx, 1);
                            room.turn = 1 - playerIdx; // Turn passes to opponent
                            room.attacker = 1 - room.attacker;
                            room.defender = 1 - room.defender;
                            room.transferred = true;
                        } else {
                            return;
                        }
                    } else {
                        // Defend
                        if (canBeat(lastAttack.attack, card, room.trump)) {
                            lastAttack.defend = card;
                            hand.splice(cardIdx, 1);
                            room.turn = room.attacker; // Back to attacker for throw or pass
                            room.phase = 'attack';
                        } else {
                            return;
                        }
                    }
                }
                broadcastRoom(ws.roomId);
            }
            
            if (data.type === 'pass') {
                // Attacker passes (no more cards to throw), or defender takes
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const playerIdx = room.players.findIndex(p => p.ws === ws);
                
                if (room.phase === 'attack' && playerIdx === room.attacker) {
                    // End of round: all defended, discard table
                    if (room.table.every(t => t.defend)) {
                        room.table = [];
                        // Draw cards
                        [room.attacker, room.defender].forEach(idx => {
                            while (room.players[idx].hand.length < 6 && room.deck.length > 0) {
                                room.players[idx].hand.push(room.deck.pop());
                            }
                        });
                        room.turn = room.attacker; // Attacker starts next round
                        room.phase = 'attack';
                    }
                } else if (room.phase === 'defend' && playerIdx === room.defender) {
                    // Defender takes cards
                    room.table.forEach(t => {
                        room.players[playerIdx].hand.push(t.attack);
                        if (t.defend) room.players[playerIdx].hand.push(t.defend);
                    });
                    room.table = [];
                    // Draw cards
                    [room.attacker, room.defender].forEach(idx => {
                        while (room.players[idx].hand.length < 6 && room.deck.length > 0) {
                            room.players[idx].hand.push(room.deck.pop());
                        }
                    });
                    room.turn = room.attacker; // Attacker repeats
                    room.phase = 'attack';
                }
                broadcastRoom(ws.roomId);
            }
            
        } catch (e) {
            console.error(e);
        }
    });
    
    ws.on('close', () => {
        if (ws.roomId) {
            const room = rooms.get(ws.roomId);
            if (room) {
                room.players.forEach(p => {
                    if (p && p.ws && p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({ type: 'error', message: 'Противник отключился' }));
                    }
                });
                rooms.delete(ws.roomId);
            }
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});