var fs = require('fs');
var EventEmitter = require('events').EventEmitter;
var SteamUser = require('steam-user');
var SteamCommunity = require('steamcommunity');
var SteamTotp = require('steam-totp');
var TradeOfferManager = require('steam-tradeoffer-manager');
var GlobalOffensive = require('globaloffensive');


module.exports = class extends EventEmitter {
    constructor() {
        super();
        this._setup();
    }
    _setup() {
        var self = this;
        self._bot_accounts = require('./config.js');
        self._bots = [];
        self._accountQueue = [];
        self._allBotsLoggedOn = false;
        self._bot_accounts.forEach(function(item, i) {
            self._accountQueue.push(new Promise(function(fulfill, reject) {
                let id = item.id;
                self._bots[id] = {};
                self._bots[id].accountData = item;
                self._bots[id].client = new SteamUser();
                self._bots[id].client.setOption("promptSteamGuardCode", false);
                self._bots[id].community = new SteamCommunity();
                self._bots[id].csgo = new GlobalOffensive(self._bots[id].client);
                self._bots[id].offers = new TradeOfferManager({
                    "steam": self._bots[id].client,
                    "domain": "",
                    "language": "en",
                    "pollInterval": 1000 * 10,
                    "cancelTime": 1000 * 60 * 3
                });
                self._bots[id].status = "offline";
                self._bots[id].pollInterval = undefined;;
                self._bots[id]._gc_status = false;
                self._bots[id]._gc_used = false;
                self._bots[id]._identity_secret = self._bots[id].accountData.identity_secret,
                    fs.readFile('./lib/polls/polldata_' + self._bots[id].accountData.id + '.json', function(err, data) {
                        if (!err) {
                            self._bots[id].offers.pollData = JSON.parse(data);
                        }
                    });
                self._bots[id].offers.on('pollFailure', function(err) {
                    self.emit('pollFailure');
                    self._bots[id].pollInterval = setInterval(function() {
                        self._bots[id].offers.doPoll();
                    }, 10000);
                });
                self._bots[id].offers.on('pollData', function(pollData) {
                    fs.writeFile('./lib/polls/polldata_' + self._bots[id].accountData.id + '.json', JSON.stringify(pollData));
                });
                self._bots[id].offers.on("newOffer", function(offer) {
                    self.emit('newOffer', self._bots[id].accountData.id, self._bots[id], offer);
                });
                self._bots[id].offers.on("sentOfferChanged", function(offer, oldState) {
                    self.emit('sentOfferChanged', self._bots[id].accountData.id, self._bots[id], offer, oldState);
                });
                self._bots[id].client.on('loggedOn', function(details) {
                    console.log("Logged into Steam as " + self._bots[id].client.steamID.getSteam3RenderedID());
                    self._bots[id].client.setPersona(SteamUser.Steam.EPersonaState.Offline, "Skin.Supply #" + id);
                    self.emit('loggedOn', self._bots[id].accountData.id, self._bots[id]);
                });
                self._bots[id].client.on('error', function(e) {
                    return reject(id);
                });
                self._bots[id].client.on('webSession', function(sessionID, cookies) {
                    self._bots[id].community.setCookies(cookies);
                    self._bots[id].offers.setCookies(cookies, function(err) {
                        if (err) {
                            console.log('Unable to set trade offer cookies: ' + err);
                            self.emit('', self._bots[id].accountData.id, self._bots[id]);
                            setTimeout(function() {
                                self._bots[id].client.webLogOn();
                            }, 1000);
                        } else {
                            console.log("Trade offer cookies set. API Key: " + self._bots[id].offers.apiKey);
                            self._bots[id].status = "online";
                            self._bots[id].client.gamesPlayed([730]);
                            self.emit('webSession', self._bots[id].accountData.id, self._bots[id]);
                        }
                    });
                });
                self._bots[id].csgo.on('connectedToGC', function() {
                    self._bots[id]._gc_status = true;
                    self.emit('gcConnected', self._bots[id].accountData.id, self._bots[id]);
                    return fulfill(item.id);
                });
                self._bots[id].csgo.on('disconnectedFromGC', function() {
                    self._bots[id]._gc_status = false;
                    self.emit('gcDisconnected', self._bots[id].accountData.id, self._bots[id]);
                });
                setTimeout(function() {
                    self._bots[id].client.logOn({
                        "accountName": self._bots[id].accountData.accountName,
                        "password": self._bots[id].accountData.password,
                        "twoFactorCode": SteamTotp.generateAuthCode(self._bots[id].accountData.shared_secret)
                    });
                }, 15 * 1000 * i);
            }).catch(function(err) {
                console.log("err", err);
            }))
        });
        Promise.all(self._accountQueue).then(function() {
            self._allBotsLoggedOn = true;
            self.emit('allBotsLoggedOn');
        });
    }
    get botCount() {
        return this._bot_accounts.length;
    }
    get getBots() {
        return this._bots;
    }
    getBot(id) {
        return this._bots[id];
    }
    getItemData(inspect_link, callback) {
        if (this._allBotsLoggedOn == true) {
            if (inspect_link != "") {
                var self = this;
                new Promise(function(fulfill, reject) {
                    (function retry() {
                        self._foundInspector = false;
                        self._bots.forEach(function(bot, index) {
                            if (bot._gc_used == false) {
                                bot._gc_used = true;
                                self._foundInspector = true;
                                return fulfill({
                                    bot: bot,
                                    id: index
                                });
                            }
                        })
                        if (self._foundInspector == false) {
                            setTimeout(function() {
                                retry();
                            }, 1000);
                        }
                    })()
                }).then(function(data) {
                    var bot = data.bot;
                    bot.csgo.inspectItem(inspect_link, function(item) {
                        bot._gc_used = false;
                        self.emit('gotItemData', item);
                        callback(undefined, item);
                    });
                })
            } else {
                this.emit('gotItemData', "invalid inspect_link");
                callback("invalid inspect_link");
            }
        } else {
            this.emit('gotItemData', "bots not logged on");
            callback("bots not logged on");
        }
    }
    makeOffer(id, tradeurl, steamid, their, mine, callback) {
        if (this._allBotsLoggedOn == true) {
            var self = this;
            var bot = self._bots[id];
            if (bot.status == "online") {
                new Promise(function(fulfill, reject) {
                    if (tradeurl.indexOf("https://steamcommunity.com/tradeoffer/new/?partner=") > -1 && tradeurl.indexOf("&token=") > -1) {
                        var offer = bot.offers.createOffer(tradeurl);
                        offer.setMessage("Trade offer");
                        if (offer.partner.getSteamID64() == steamid) {
                            offer.getUserDetails(function(err, me, them) {
                                if (!err) {
                                    if (me.escrowDays == 0 && them.escrowDays == 0) {
                                        return fulfill({
                                            offer: offer
                                        });
                                    } else {
                                        return reject("Escrow!");
                                    }
                                } else {
                                    return reject("Can´t get user details, try again later");
                                }
                            })
                        } else {
                            return reject("Tradeurl owner and user logged-in not the same!");
                        }
                    } else {
                        return reject("Invalid Tradeurl");
                    }
                }).then(function(data) {
                    var offer = data.offer;
                    if (mine.length > 0) {
                        offer.addMyItems(mine.map(function(item) {
                            return {
                                assetid: item.assetid,
                                appid: 730,
                                contextid: 2,
                                amount: 1
                            }
                        }))
                    }
                    if (their.length > 0) {
                        offer.addTheirItems(their.map(function(item) {
                            return {
                                assetid: item.assetid,
                                appid: 730,
                                contextid: 2,
                                amount: 1
                            }
                        }))
                    }
                    self.emit('createdOffer', offer, bot, id);
                    callback(null, offer);
                }).catch(function(data) {
                    self.emit('createdOffer', data);
                    callback(data);
                })
            } else {
                self.emit('createdOffer', "Invalid bot ID [ Bot not up and running or not added ]");
                callback("Invalid bot ID [ Bot not up and running or not added ]");
            }
        }
    }
    confirmOffer(id, offer, callback) {
        if (this._allBotsLoggedOn == true) {
            var self = this;
            var bot = self._bots[id];
            if (bot.status == "online") {
                console.log(offer);
                bot.community.acceptConfirmationForObject(bot._identity_secret, offer.id, function(err) {
                    callback(err);
                    self.emit('confirmOffer', err, offer, bot, id);
                })
            };
        };
    };
}