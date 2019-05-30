/* global module */

let Character = require('../character'),
    Incoming = require('../../../../controllers/incoming'),
    Armour = require('./equipment/armour'),
    Weapon = require('./equipment/weapon'),
    Pendant = require('./equipment/pendant'),
    Ring = require('./equipment/ring'),
    Boots = require('./equipment/boots'),
    Items = require('../../../../util/items'),
    Messages = require('../../../../network/messages'),
    Formulas = require('../../../../util/formulas'),
    HitPoints = require('./points/hitpoints'),
    Mana = require('./points/mana'),
    Packets = require('../../../../network/packets'),
    Modules = require('../../../../util/modules'),
    Handler = require('./handler'),
    Quests = require('../../../../controllers/quests'),
    Inventory = require('./containers/inventory/inventory'),
    Abilities = require('./ability/abilities'),
    Bank = require('./containers/bank/bank'),
    config = require('../../../../../config.json'),
    Enchant = require('./enchant'),
    Utils = require('../../../../util/utils'),
    Hit = require('../combat/hit'),
    Trade = require('./trade'),
    Warp = require('./warp'),
    Guild = require('./guild'),
    Doors = require('./doors');

class Player extends Character {

    constructor(world, database, connection, clientId) {
        super(-1, 'player', connection.id, -1, -1);

        let self = this;

        self.world = world;
        self.database = database;
        self.connection = connection;

        self.clientId = clientId;

        self.incoming = new Incoming(self);

        self.isNew = false;
        self.ready = false;

        self.moving = false;
        self.potentialPosition = null;
        self.futurePosition = null;

        self.regionPosition = null;
        self.newRegion = false;

        self.team = null;

        self.disconnectTimeout = null;
        self.timeoutDuration = 1000 * 60 * 10; //10 minutes
        self.lastRegionChange = new Date().getTime();

        self.handler = new Handler(self);

        self.inventory = new Inventory(self, 20);
        self.abilities = new Abilities(self);
        self.enchant = new Enchant(self);
        self.bank = new Bank(self, 56);
        self.quests = new Quests(self);
        self.trade = new Trade(self);
        self.doors = new Doors(self);
        self.warp = new Warp(self);

        self.introduced = false;
        self.currentSong = null;
        self.acceptedTrade = false;
        self.invincible = false;
        self.noDamage = false;
        self.isGuest = false;

        self.pvp = false;

        self.canTalk = true;

        self.profileDialogOpen = false;

        self.instanced = false;
        self.visible = true;
        self.regionsLoaded = [];
        self.lightsLoaded = [];
    }

    load(data) {
        let self = this;

        self.kind = data.kind;
        self.rights = data.rights;
        self.experience = data.experience;
        self.ban = data.ban;
        self.mute = data.mute;
        self.membership = data.membership;
        self.lastLogin = data.lastLogin;
        self.pvpKills = data.pvpKills;
        self.pvpDeaths = data.pvpDeaths;

        self.warp.setLastWarp(data.lastWarp);

        self.level = Formulas.expToLevel(self.experience);
        self.hitPoints = new HitPoints(data.hitPoints, Formulas.getMaxHitPoints(self.level));
        self.mana = new Mana(data.mana, Formulas.getMaxMana(self.level));

        if (data.invisibleIds)
            self.invisiblesIds = data.invisibleIds.split(" ");

        let armour = data.armour,
            weapon = data.weapon,
            pendant = data.pendant,
            ring = data.ring,
            boots = data.boots;

        self.setPosition(data.x, data.y);
        self.setArmour(armour[0], armour[1], armour[2], armour[3]);
        self.setWeapon(weapon[0], weapon[1], weapon[2], weapon[3]);
        self.setPendant(pendant[0], pendant[1], pendant[2], pendant[3]);
        self.setRing(ring[0], ring[1], ring[2], ring[3]);
        self.setBoots(boots[0], boots[1], boots[2], boots[3]);

        self.guild = new Guild(self, null);
    }

    loadInventory() {
        let self = this;

        if (config.offlineMode) {
            self.inventory.loadEmpty();
            return;
        }

        self.database.loader.getInventory(self, function(ids, counts, skills, skillLevels) {
            if (ids.length !== self.inventory.size)
                self.save();

            self.inventory.load(ids, counts, skills, skillLevels);
            self.inventory.check();
        });
    }

    loadBank() {
        let self = this;

        if (config.offlineMode) {
            self.bank.loadEmpty();
            return;
        }

        self.database.loader.getBank(self, function(ids, counts, skills, skillLevels) {
            if (ids.length !== self.bank.size)
                self.save();

            self.bank.load(ids, counts, skills, skillLevels);
            self.bank.check();
        });
    }

    loadQuests() {
        let self = this;

        if (config.offlineMode)
            return;

        self.database.loader.getQuests(self, function(ids, stages) {
            if (!ids || !stages) {
                self.quests.updateQuests(ids, stages);
                return;
            }

            ids.pop();
            stages.pop();

            if (self.quests.getQuestSize() !== ids.length) {
                log.info('Mismatch in quest data.');

                self.save();
            }

            self.quests.updateQuests(ids, stages);
        });

        self.database.loader.getAchievements(self, function(ids, progress) {
            ids.pop();
            progress.pop();

            if (self.quests.getAchievementSize() !== ids.length) {
                log.info('Mismatch in achievements data.');

                self.save();
            }

            self.quests.updateAchievements(ids, progress);
        });

        self.quests.onReady(function() {
            self.send(new Messages.Quest(Packets.QuestOpcode.Batch, self.quests.getData()));

            self.updateRegion();
        });
    }

    intro() {
        let self = this;

        if (self.ban > new Date()) {
            self.connection.sendUTF8('ban');
            self.connection.close('Player: ' + self.username + ' is banned.');
        }

        if (self.x <= 0 || self.y <= 0)
            self.sendToSpawn();

        if (self.hitPoints.getHitPoints() < 0)
            self.hitPoints.setHitPoints(self.getMaxHitPoints());

        if (self.mana.getMana() < 0)
            self.mana.setMana(self.mana.getMaxMana());

        self.verifyRights();

        let info = {
            instance: self.instance,
            username: self.username.charAt(0).toUpperCase() + self.username.substr(1),
            x: self.x,
            y: self.y,
            kind: self.kind,
            rights: self.rights,
            hitPoints: self.hitPoints.getData(),
            mana: self.mana.getData(),
            experience: self.experience,
            level: self.level,
            lastLogin: self.lastLogin,
            pvpKills: self.pvpKills,
            pvpDeaths: self.pvpDeaths
        };

        self.regionPosition = [self.x, self.y];

        /**
         * Send player data to client here
         */

        self.world.addPlayer(self);

        self.send(new Messages.Welcome(info));
    }

    verifyRights() {
        let self = this;

        if (config.moderators.indexOf(self.username.toLowerCase()) > -1)
            self.rights = 1;

        if (config.administrators.indexOf(self.username.toLowerCase()) > -1)
            self.rights = 2;
    }

    addExperience(exp) {
        let self = this;

        self.experience += exp;

        let oldLevel = self.level;

        self.level = Formulas.expToLevel(self.experience);

        if (oldLevel !== self.level)
            self.hitPoints.setMaxHitPoints(Formulas.getMaxHitPoints(self.level));

        self.sendToAdjacentRegions(self.region, new Messages.Experience({
            id: self.instance,
            amount: exp,
            experience: self.experience,
            level: self.level
        }));
    }

    heal(amount) {
        let self = this;

        /**
         * Passed from the superclass...
         */

        if (!self.hitPoints || !self.mana)
            return;

        self.hitPoints.heal(amount);
        self.mana.heal(amount);

        self.sync();
    }

    healHitPoints(amount) {
        let self = this,
            type = 'health';

        self.hitPoints.heal(amount);

        self.sync();

        self.sendToAdjacentRegions(self.region, new Messages.Heal({
            id: self.instance,
            type: type,
            amount: amount
        }));
    }

    healManaPoints(amount) {
        let self = this,
            type = 'mana';

        self.mana.heal(amount);

        self.sync();

        self.sendToAdjacentRegions(self.region, new Messages.Heal({
            id: self.instance,
            type: type,
            amount: amount
        }));
    }


    eat(id) {
        let self = this,
            type, amount;

        if (Items.hasPlugin(id))
            (new (Items.isNewPlugin(id))(id, -1, self.x,self.y)).onUse(self);

    }

    equip(string, count, ability, abilityLevel) {
        let self = this,
            data = Items.getData(string),
            type, id;

        if (!data || data === 'null')
            return;

        if (Items.isArmour(string))
            type = Modules.Equipment.Armour;
        else if (Items.isWeapon(string))
            type = Modules.Equipment.Weapon;
        else if (Items.isPendant(string))
            type = Modules.Equipment.Pendant;
        else if (Items.isRing(string))
            type = Modules.Equipment.Ring;
        else if (Items.isBoots(string))
            type = Modules.Equipment.Boots;

        id = Items.stringToId(string);

        switch(type) {
            case Modules.Equipment.Armour:

                if (self.hasArmour() && self.armour.id !== 114)
                    self.inventory.add(self.armour.getItem());

                self.setArmour(id, count, ability, abilityLevel);
                break;

            case Modules.Equipment.Weapon:

                if (self.hasWeapon())
                    self.inventory.add(self.weapon.getItem());

                self.setWeapon(id, count, ability, abilityLevel);
                break;

            case Modules.Equipment.Pendant:

                if (self.hasPendant())
                    self.inventory.add(self.pendant.getItem());

                self.setPendant(id, count, ability, abilityLevel);
                break;

            case Modules.Equipment.Ring:

                if (self.hasRing())
                    self.inventory.add(self.ring.getItem());

                self.setRing(id, count, ability, abilityLevel);
                break;

            case Modules.Equipment.Boots:

                if (self.hasBoots())
                    self.inventory.add(self.boots.getItem());

                self.setBoots(id, count, ability, abilityLevel);
                break;
        }

        self.send(new Messages.Equipment(Packets.EquipmentOpcode.Equip, [type, Items.idToName(id), string, count, ability, abilityLevel]));

        self.sync();
    }

    updateRegion(force) {
        this.world.region.sendRegion(this, this.region, force);
    }

    isInvisible(instance) {
        let self = this,
            entity = self.world.getEntityByInstance(instance);

        if (!entity)
            return false;

        return super.hasInvisibleId(entity.id) || super.hasInvisible(entity);
    }

    formatInvisibles() {
        return this.invisiblesIds.join(" ");
    }

    canEquip(string) {
        let self = this,
            requirement = Items.getLevelRequirement(string);

        if (requirement > self.level) {
            self.notify('You must be at least level ' + requirement + ' to equip this.');
            return false;
        }

        return true;
    }

    die() {
        let self = this;

        self.dead = true;

        if (self.deathCallback)
            self.deathCallback();

        self.send(new Messages.Death(self.instance));
    }

    teleport(x, y, isDoor, animate) {
        let self = this;

        if (isDoor && !self.finishedTutorial()) {
            if (self.doorCallback)
                self.doorCallback(x, y);

            return;
        }

        self.sendToAdjacentRegions(self.region, new Messages.Teleport(self.instance, x, y, animate));

        self.setPosition(x, y);
        self.checkRegions();

        self.updateRegion(true);
        self.world.cleanCombat(self);
    }

    updatePVP(pvp) {
        let self = this;

        /**
         * No need to update if the state is the same
         */

        if (self.pvp === pvp)
            return;

        if (self.pvp && !pvp)
            self.notify('You are no longer in a PvP zone!');
        else
            self.notify('You have entered a PvP zone!');

        self.pvp = pvp;

        self.sendToRegion(new Messages.PVP(self.instance, self.pvp));
    }

    updateOverlay(overlay) {
        let self = this;

        if (self.overlayArea === overlay)
            return;

        self.overlayArea = overlay;

        if (overlay && overlay.id) {
            self.lightsLoaded = [];

            self.send(new Messages.Overlay(Packets.OverlayOpcode.Set, {
                image: overlay.fog ? overlay.fog : 'empty',
                colour: 'rgba(0,0,0,' + overlay.darkness + ')'
            }));
        } else
            self.send(new Messages.Overlay(Packets.OverlayOpcode.Remove));
    }

    updateCamera(camera) {
        let self = this;

        if (self.cameraArea === camera)
            return;

        self.cameraArea = camera;

        if (camera) {
            switch(camera.type) {
                case 'lockX':
                    self.send(new Messages.Camera(Packets.CameraOpcode.LockX));
                    break;

                case 'lockY':
                    self.send(new Messages.Camera(Packets.CameraOpcode.LockY));
                    break;

                case 'player':
                    self.send(new Messages.Camera(Packets.CameraOpcode.Player));
                    break;
            }

        } else
            self.send(new Messages.Camera(Packets.CameraOpcode.FreeFlow));
    }

    updateMusic(song) {
        let self = this;

        self.currentSong = song;

        self.send(new Messages.Audio(song));
    }

    revertPoints() {
        let self = this;

        self.hitPoints.setHitPoints(self.hitPoints.getMaxHitPoints());
        self.mana.setMana(self.mana.getMaxMana());

        self.sync();
    }

    applyDamage(damage) {
        this.hitPoints.decrement(damage);
    }

    toggleProfile(state) {
        let self = this;

        self.profileDialogOpen = state;

        if (self.profileToggleCallback)
            self.profileToggleCallback();
    }

    getMana() {
        return this.mana.getMana();
    }

    getMaxMana() {
        return this.mana.getMaxMana();
    }

    getHitPoints() {
        return this.hitPoints.getHitPoints();
    }

    getMaxHitPoints() {
        return this.hitPoints.getMaxHitPoints();
    }

    getTutorial() {
        return this.quests.getQuest(Modules.Quests.Introduction);
    }

    /**
     * Setters
     */

    setArmour(id, count, ability, abilityLevel) {
        let self = this;

        if (!id)
            return;

        self.armour = new Armour(Items.idToString(id), id, count, ability, abilityLevel);
    }

    breakWeapon() {
        let self = this;

        self.notify('Your weapon has been broken.');

        self.setWeapon(-1, 0, 0, 0);

        self.sendEquipment();
    }

    setWeapon(id, count, ability, abilityLevel) {
        let self = this;

        if (!id)
            return;

        self.weapon = new Weapon(Items.idToString(id), id, count, ability, abilityLevel);

        if (self.weapon.ranged)
            self.attackRange = 7;
    }

    setPendant(id, count, ability, abilityLevel) {
        let self = this;

        if (!id)
            return;

        self.pendant = new Pendant(Items.idToString(id), id, count, ability, abilityLevel);
    }

    setRing(id, count, ability, abilityLevel) {
        let self = this;

        if (!id)
            return;

        self.ring = new Ring(Items.idToString(id), id, count, ability, abilityLevel);
    }

    setBoots(id, count, ability, abilityLevel) {
        let self = this;

        if (!id)
            return;

        self.boots = new Boots(Items.idToString(id), id, count, ability, abilityLevel);
    }

    guessPosition(x, y) {
        this.potentialPosition = {
            x: x,
            y: y
        }
    }

    setPosition(x, y) {
        let self = this;

        if (self.dead)
            return;

        if (self.world.map.isOutOfBounds(x, y)) {
            x = 50;
            y = 89;
        }

        super.setPosition(x, y);

        self.sendToAdjacentRegions(self.region, new Messages.Movement(Packets.MovementOpcode.Move, [self.instance, x, y, false, false]), self.instance);
    }

    setFuturePosition(x, y) {
        /**
         * Most likely will be used for anti-cheating methods
         * of calculating the actual time and duration for the
         * displacement.
         */

        this.futurePosition = {
            x: x,
            y: y
        }
    }

    hasLoadedRegion(region) {
        return this.regionsLoaded.indexOf(region) > -1;
    }

    hasLoadedLight(light) {
        return this.lightsLoaded.indexOf(light) > -1;
    }

    timeout() {
        let self = this;

        self.connection.sendUTF8('timeout');
        self.connection.close('Player timed out.');
    }

    refreshTimeout() {
        let self = this;

        clearTimeout(self.disconnectTimeout);

        self.disconnectTimeout = setTimeout(function() {

            self.timeout();

        }, self.timeoutDuration);
    }

    /**
     * Getters
     */

    hasArmour() {
        return this.armour && this.armour.name !== 'null' && this.armour.id !== -1;
    }

    hasWeapon() {
        return this.weapon && this.weapon.name !== 'null' && this.weapon.id !== -1;
    }

    hasBreakableWeapon() {
        return this.weapon && this.weapon.breakable;
    }

    hasPendant() {
        return this.pendant && this.pendant.name !== 'null' && this.pendant.id !== -1;
    }

    hasRing() {
        return this.ring && this.ring.name !== 'null' && this.ring.id !== -1;
    }

    hasBoots() {
        return this.boots && this.boots.name !== 'null' && this.boots.id !== -1;
    }

    hasMaxHitPoints() {
        return this.getHitPoints() >= this.hitPoints.getMaxHitPoints();
    }

    hasMaxMana() {
        return this.mana.getMana() >= this.mana.getMaxMana();
    }

    hasSpecialAttack() {
        return this.weapon && (this.weapon.hasCritical() || this.weapon.hasExplosive() || this.weapon.hasStun());
    }

    hasGuild() {

    }

    canBeStunned() {
        return true;
    }

    getState() {
        let self = this;

        return {
            type: self.type,
            id: self.instance,
            name: self.username,
            x: self.x,
            y: self.y,
            rights: self.rights,
            level: self.level,
            pvp: self.pvp,
            pvpKills: self.pvpKills,
            pvpDeaths: self.pvpDeaths,
            hitPoints: self.hitPoints.getData(),
            mana: self.mana.getData(),
            armour: self.armour.getData(),
            weapon: self.weapon.getData(),
            pendant: self.pendant.getData(),
            ring: self.ring.getData(),
            boots: self.boots.getData()
        };
    }

    getRemoteAddress() {
        return this.connection.socket.conn.remoteAddress;
    }

    getSpawn() {
        let self = this,
            position;

        /**
         * Here we will implement functions from quests and
         * other special events and determine a spawn point.
         */

        return self.finishedTutorial() ? { x: 324, y: 86 } : { x: 17, y: 557 };
    }

    getHit(target) {
        let self = this;

        let defaultDamage = Formulas.getDamage(self, target),
            isSpecial = 100 - self.weapon.abilityLevel < Utils.randomInt(0, 100);

        if (!self.hasSpecialAttack() || !isSpecial)
            return new Hit(Modules.Hits.Damage, defaultDamage);

        switch (self.weapon.ability) {

            case Modules.Enchantment.Critical:

                /**
                 * Still experimental, not sure how likely it is that you're
                 * gonna do a critical strike. I just do not want it getting
                 * out of hand, it's easier to buff than to nerf..
                 */

                let multiplier = 1.00 + self.weapon.abilityLevel,
                    damage = defaultDamage * multiplier;

                return new Hit(Modules.Hits.Critical, damage);

            case Modules.Enchantment.Stun:
                return new Hit(Modules.Hits.Stun, defaultDamage);

            case Modules.Enchantment.Explosive:
                return new Hit(Modules.Hits.Explosive, defaultDamage);

        }
    }

    isMuted() {
        let self = this,
            time = new Date().getTime();

        return self.mute - time > 0;
    }

    isRanged() {
        return this.weapon && this.weapon.isRanged();
    }

    isDead() {
        return this.getHitPoints() < 1 || this.dead;
    }

    /**
     * Miscellaneous
     */

    send(message) {
        this.world.network.pushToPlayer(this, message);
    }

    sendToRegion(message) {
        this.world.network.pushToRegion(this.region, message);
    }

    sendToAdjacentRegions(regionId, message, ignoreId) {
        this.world.network.pushToAdjacentRegions(regionId, message, ignoreId);
    }

    sendEquipment() {
        let self = this,
            info = {
                armour: self.armour.getData(),
                weapon: self.weapon.getData(),
                pendant: self.pendant.getData(),
                ring: self.ring.getData(),
                boots: self.boots.getData()
            };

        self.send(new Messages.Equipment(Packets.EquipmentOpcode.Batch, info));
    }

    sendToSpawn() {
        let self = this,
            position = self.getSpawn();

        self.x = position.x;
        self.y = position.y;
    }

    sync(all) {
        let self = this;

        /**
         * Function to be used for syncing up health,
         * mana, exp, and other letiables
         */

        if (!self.hitPoints || !self.mana)
            return;

        let info = {
            id: self.instance,
            hitPoints: self.getHitPoints(),
            maxHitPoints: self.getMaxHitPoints(),
            mana: self.mana.getMana(),
            maxMana: self.mana.getMaxMana(),
            experience: self.experience,
            level: self.level,
            armour: self.armour.getString(),
            weapon: self.weapon.getData()
        };

        self.sendToAdjacentRegions(self.region, new Messages.Sync(info), all ? null : self.instance);

        self.save();
    }

    notify(message) {
        let self = this;

        if (!message)
            return;

        self.send(new Messages.Notification(Packets.NotificationOpcode.Text, message));
    }

    stopMovement(force) {
        /**
         * Forcefully stopping the player will simply halt
         * them in between tiles. Should only be used if they are
         * being transported elsewhere.
         */

        let self = this;

        self.send(new Messages.Movement(Packets.MovementOpcode.Stop, {
            instance: self.instance,
            force: force
        }));
    }

    finishedTutorial() {
        let self = this;

        if (!self.quests)
            return true;

        return self.quests.getQuest(0).isFinished();
    }

    checkRegions() {
        let self = this;

        if (!self.regionPosition)
            return;

        let diffX = Math.abs(self.regionPosition[0] - self.x),
            diffY = Math.abs(self.regionPosition[1] - self.y);

        if (diffX >= 10 || diffY >= 10) {
            self.regionPosition = [self.x, self.y];

            if (self.regionCallback)
                self.regionCallback();
        }
    }

    movePlayer() {
        let self = this;

        /**
         * Server-sided callbacks towards movement should
         * not be able to be overwritten. In the case that
         * this is used (for Quests most likely) the server must
         * check that no hacker removed the constraint in the client-side.
         * If they are not within the bounds, apply the according punishment.
         */

        self.send(new Messages.Movement(Packets.MovementOpcode.Started));
    }

    walkRandomly() {
        let self = this;

        setInterval(function() {
            self.setPosition(self.x + Utils.randomInt(-5, 5), self.y + Utils.randomInt(-5, 5));
        }, 2000);

    }

    killCharacter(character) {
        let self = this;

        if (self.killCallback)
            self.killCallback(character);
    }

    save() {
        let self = this;

        if (config.offlineMode || self.isGuest)
            return;

        self.database.creator.save(self);
    }

    inTutorial() {
        return this.world.map.inTutorialArea(this);
    }

    hasAggressionTimer() {
        return new Date().getTime() - this.lastRegionChange < 1200000; // 20 Minutes
    }

    onRegion(callback) {
        this.regionCallback = callback;
    }

    onAttack(callback) {
        this.attackCallback = callback;
    }

    onHit(callback) {
        this.hitCallback = callback;
    }

    onKill(callback) {
        this.killCallback = callback;
    }

    onDeath(callback) {
        this.deathCallback = callback;
    }

    onTalkToNPC(callback) {
        this.npcTalkCallback = callback;
    }

    onDoor(callback) {
        this.doorCallback = callback;
    }

    onProfile(callback) {
        this.profileToggleCallback = callback;
    }

    onReady(callback) {
        this.readyCallback = callback;
    }

}

module.exports = Player;