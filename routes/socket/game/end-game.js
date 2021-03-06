const { sendInProgressGameUpdate } = require('../util.js');
const { userList, games } = require('../models.js');
const { sendUserList, sendGameList } = require('../user-requests.js');
const Account = require('../../../models/account.js');
const Game = require('../../../models/game');
const buildEnhancedGameSummary = require('../../../models/game-summary/buildEnhancedGameSummary');
const { updateProfiles } = require('../../../models/profile/utils');
const debug = require('debug')('game:summary');
const _ = require('lodash');

const saveGame = game => {
	const summary = game.private.summary.publish();
	const gameToSave = new Game({
		uid: game.general.uid,
		date: new Date(),
		chats: game.chats,
		winningPlayers: game.private.seatedPlayers.filter(player => player.wonGame).map(player => ({
			userName: player.userName,
			team: player.role.team,
			role: player.role.cardName
		})),
		losingPlayers: game.private.seatedPlayers.filter(player => !player.wonGame).map(player => ({
			userName: player.userName,
			team: player.role.team,
			role: player.role.cardName
		})),
		winningTeam: game.gameState.isCompleted,
		playerCount: game.general.playerCount,
		rebalance6p: game.general.rebalance6p,
		rebalance7p: game.general.rebalance7p,
		rebalance9p: game.general.rebalance9p,
		isTournyFirstRound: game.general.isTourny && game.general.tournyInfo.round === 1,
		isTournySecondRound: game.general.isTourny && game.general.tournyInfo.round === 2
	});

	let enhanced;

	try {
		if (summary && summary.toObject() && game.general.uid !== 'devgame' && !game.general.private) {
			enhanced = buildEnhancedGameSummary(summary.toObject());
			updateProfiles(enhanced, { cache: true });
			summary.save();
		} else {
			console.log(summary, 'problem with summary');
		}
	} catch (error) {
		console.log(error, 'error in enhanced/end-game');
	}

	debug('Saving game: %O', summary);
	gameToSave.save();
};

/**
 * @param {object} game - game to act on.
 * @param {string} winningTeamName - name of the team that won this game.
 */
module.exports.completeGame = (game, winningTeamName) => {
	const winningPrivatePlayers = game.private.seatedPlayers.filter(player => player.role.team === winningTeamName);
	const winningPlayerNames = winningPrivatePlayers.map(player => player.userName);
	const { seatedPlayers } = game.private;
	const { publicPlayersState } = game;
	const chat = {
		gameChat: true,
		timestamp: new Date(),
		chat: [
			{
				text: winningTeamName === 'fascist' ? 'Fascists' : 'Liberals',
				type: winningTeamName === 'fascist' ? 'fascist' : 'liberal'
			},
			{ text: ' win the game.' }
		]
	};

	if (!(game.general.isTourny && game.general.tournyInfo.round === 1)) {
		winningPrivatePlayers.forEach((player, index) => {
			publicPlayersState.find(play => play.userName === player.userName).notificationStatus = 'success';
			publicPlayersState.find(play => play.userName === player.userName).isConfetti = true;
			player.wonGame = true;
		});

		setTimeout(() => {
			winningPrivatePlayers.forEach((player, index) => {
				publicPlayersState.find(play => play.userName === player.userName).isConfetti = false;
			});
			sendInProgressGameUpdate(game);
		}, 15000);
	}

	game.general.status = winningTeamName === 'fascist' ? 'Fascists win the game.' : 'Liberals win the game.';
	game.gameState.isCompleted = winningTeamName;
	sendGameList();

	publicPlayersState.forEach((publicPlayer, index) => {
		publicPlayer.nameStatus = seatedPlayers[index].role.cardName;
	});

	seatedPlayers.forEach(player => {
		player.gameChats.push(chat);
	});

	game.private.unSeatedGameChats.push(chat);

	game.summary = game.private.summary;
	debug('Final game summary: %O', game.summary.publish().toObject());

	sendInProgressGameUpdate(game);

	saveGame(game);

	if (!game.general.private) {
		Account.find({
			username: { $in: seatedPlayers.map(player => player.userName) }
		})
			.then(results => {
				const isRainbow = game.general.rainbowgame;
				const isTournamentFinalGame = game.general.isTourny && game.general.tournyInfo.round === 2;

				results.forEach(player => {
					let winner = false;

					if (winningPlayerNames.includes(player.username)) {
						if (isRainbow) {
							player.rainbowWins = player.rainbowWins ? player.rainbowWins + 1 : 1;
							player.rainbowLosses = player.rainbowLosses ? player.rainbowLosses : 0;
						} else {
							player.wins++;
						}
						winner = true;
						if (isTournamentFinalGame) {
							player.gameSettings.tournyWins.push(new Date().getTime());
							const playerSocketId = Object.keys(io.sockets.sockets).find(
								socketId =>
									io.sockets.sockets[socketId].handshake.session.passport && io.sockets.sockets[socketId].handshake.session.passport.user === player.username
							);

							io.sockets.sockets[playerSocketId].emit('gameSettings', player.gameSettings);
						}
					} else {
						if (isRainbow) {
							player.rainbowLosses = player.rainbowLosses ? player.rainbowLosses + 1 : 1;
							player.rainbowWins = player.rainbowWins ? player.rainbowWins : 0;
						} else {
							player.losses++;
						}
					}

					player.games.push(game.general.uid);
					player.save(() => {
						const userEntry = userList.find(user => user.userName === player.username);

						if (userEntry) {
							if (winner) {
								if (isRainbow) {
									userEntry.rainbowWins = userEntry.rainbowWins ? userEntry.rainbowWins + 1 : 1;
								} else {
									userEntry.wins++;
								}
								if (isTournamentFinalGame) {
									userEntry.tournyWins.push(new Date().getTime());
								}
							} else {
								if (isRainbow) {
									userEntry.rainbowLosses = userEntry.rainbowLosses ? userEntry.rainbowLosses + 1 : 1;
								} else {
									userEntry.losses++;
								}
							}

							sendUserList();
						}
					});
				});
			})
			.catch(err => {
				console.log(err, 'error in updating accounts at end of game');
			});
	}

	if (game.general.isTourny) {
		if (game.general.tournyInfo.round === 1) {
			const { uid } = game.general;
			const tableUidLastLetter = uid.charAt(uid.length - 1);
			const otherUid = tableUidLastLetter === 'A' ? `${uid.substr(0, uid.length - 1)}B` : `${uid.substr(0, uid.length - 1)}A`;
			const otherGame = games.find(g => g.general.uid === otherUid);

			if (!otherGame || otherGame.gameState.isCompleted) {
				const finalGame = _.cloneDeep(game);
				let gamePause = 10;

				finalGame.general.uid = `${uid.substr(0, uid.length - 1)}Final`;
				finalGame.general.timeCreated = new Date();
				finalGame.gameState = {
					previousElectedGovernment: [],
					undrawnPolicyCount: 17,
					discardedPolicyCount: 0,
					presidentIndex: -1,
					isStarted: true
				};

				const countDown = setInterval(() => {
					if (gamePause) {
						game.general.status = `Final game starts in ${gamePause} ${gamePause === 1 ? 'second' : 'seconds'}.`;
						if (otherGame) {
							otherGame.general.status = `Final game starts in ${gamePause} ${gamePause === 1 ? 'second' : 'seconds'}.`;
							sendInProgressGameUpdate(otherGame);
						}
						sendInProgressGameUpdate(game);
						gamePause--;
					} else {
						clearInterval(countDown);
						game.general.status = 'Final game has begun.';
						if (otherGame) {
							otherGame.general.status = 'Final game has begun.';
							sendInProgressGameUpdate(otherGame);
						}
						game.general.tournyInfo.isRound1TableThatFinished2nd = true;
						sendInProgressGameUpdate(game);
						const winningPlayerSocketIds = Object.keys(io.sockets.sockets).filter(
							socketId =>
								io.sockets.sockets[socketId].handshake.session.passport &&
								winningPrivatePlayers.map(player => player.userName).includes(io.sockets.sockets[socketId].handshake.session.passport.user)
						);

						const otherGameWinningPlayerSocketIds = Object.keys(io.sockets.sockets).filter(
							socketId =>
								io.sockets.sockets[socketId].handshake.session.passport &&
								game.general.tournyInfo.winningPlayersFirstCompletedGame
									.map(player => player.userName)
									.includes(io.sockets.sockets[socketId].handshake.session.passport.user)
						);

						const socketIds = winningPlayerSocketIds.concat(otherGameWinningPlayerSocketIds);

						socketIds.forEach(id => {
							const socket = io.sockets.sockets[id];

							Object.keys(socket.rooms).forEach(roomUid => {
								socket.leave(roomUid);
							});
							socket.join(finalGame.general.uid);
							socket.emit('joinGameRedirect', finalGame.general.uid);
						});

						finalGame.general.tournyInfo.round = 2;
						finalGame.general.electionCount = 0;
						finalGame.publicPlayersState = game.general.tournyInfo.winningPlayersFirstCompletedGame.concat(
							game.private.seatedPlayers.filter(player => player.role.team === winningTeamName)
						);
						finalGame.general.name = `${game.general.name.slice(0, game.general.name.length - 7)}-tableFINAL`;
						games.push(finalGame);
						require('./start-game.js')(finalGame); // circular dep.
						sendGameList();
					}
				}, 1000);
			} else {
				game.general.tournyInfo.showOtherTournyTable = true;
				game.chats.push({
					gameChat: true,
					timestamp: new Date(),
					chat: [
						{
							text: 'This tournament game has finished first.  Winning players will be pulled into the final round when it starts.'
						}
					]
				});
				otherGame.general.tournyInfo.winningPlayersFirstCompletedGame = _.cloneDeep(game.private.seatedPlayers).filter(
					player => player.role.team === winningTeamName
				);
				sendInProgressGameUpdate(game);
			}
		} else {
			game.publicPlayersState.forEach(player => {
				if (winningPlayerNames.includes(player.userName)) {
					player.tournyWins.push(new Date().getTime());
				}
			});
			game.chats.push({
				gameChat: true,
				timestamp: new Date(),
				chat: [
					{
						text: 'The tournament has ended.'
					}
				]
			});
			game.general.status = 'The tournament has ended.';
			sendInProgressGameUpdate(game);
		}
	}
};
