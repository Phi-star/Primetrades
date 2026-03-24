const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { Dropbox } = require('dropbox');
const NodeCache = require('node-cache');

// ==================== CONFIGURATION ====================
const IS_HEROKU = process.env.DYNO !== undefined; // Heroku sets DYNO on every dyno
const PORT = process.env.PORT || 3000;
// Set HEROKU_APP_URL in Heroku config vars → e.g. https://your-app.herokuapp.com
const HEROKU_DOMAIN = process.env.HEROKU_APP_URL || `http://localhost:${PORT}`;

const ADMIN_CHAT_ID = '6300694007';
const ADMIN_USERNAME = 'admin';
const SHORT_DOMAIN = 'primetrade';

// ==================== MULTI-DATABASE SYSTEM ====================
class MultiDatabase {
    constructor() {
        this.dbPaths = [
            path.join(__dirname, 'database_admin.json'),    // 0: settings, admin, groups
            path.join(__dirname, 'database_api.json'),      // 1: membership checks
            path.join(__dirname, 'database_users1.json'),   // 2: users shard 1
            path.join(__dirname, 'database_users2.json'),   // 3: users shard 2
            path.join(__dirname, 'database_users3.json'),   // 4: users shard 3
            path.join(__dirname, 'database_history.json'),  // 5: trade history
            path.join(__dirname, 'database_finance.json'),  // 6: wallets, withdrawals, accounts
            path.join(__dirname, 'database_support.json')   // 7: support tickets
        ];
        this.initAllDatabases();
    }

    initAllDatabases() {
        this.dbPaths.forEach((dbPath, index) => {
            if (!fs.existsSync(dbPath)) {
                let initialData;
                if (index === 0) {
                    initialData = {
                        settings: {
                            welcomeMessage: '👋 *Welcome to Primetrade!*\n\nCreate your account to start trading.',
                            payoutPercentage: 86,
                            winRate: 50,
                            minTradeAmount: 3,
                            minDepositAmount: 10,
                            minWithdrawalAmount: 20,
                            usdToNgn: 1500
                        },
                        admin: { chatId: ADMIN_CHAT_ID, username: ADMIN_USERNAME, lastActive: new Date().toISOString() },
                        groups: [],
                        pendingGroups: [],
                        version: '1.0'
                    };
                } else if (index === 1) {
                    initialData = { membershipChecks: {} };
                } else if (index >= 2 && index <= 4) {
                    initialData = {
                        users: {},
                        statistics: { totalUsers: 0, usersToday: 0, lastReset: new Date().toISOString().split('T')[0] }
                    };
                } else if (index === 5) {
                    initialData = { trades: {} };
                } else if (index === 6) {
                    initialData = { wallets: {}, withdrawals: {}, withdrawalAccounts: {} };
                } else if (index === 7) {
                    initialData = { tickets: [], chatLogs: {} };
                }
                fs.writeFileSync(dbPath, JSON.stringify(initialData, null, 2));
            }
        });
        console.log('✅ All 8 databases initialized');
    }

    getDatabasePath(userId) {
        if (userId === ADMIN_CHAT_ID) return this.dbPaths[0];
        const hash = crypto.createHash('md5').update(userId.toString()).digest('hex');
        const dbIndex = (parseInt(hash.substr(0, 8), 16) % 3) + 2;
        return this.dbPaths[dbIndex];
    }

    readDatabase(dbIndex) {
        try {
            const data = fs.readFileSync(this.dbPaths[dbIndex], 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error(`❌ Error reading database ${dbIndex}:`, error);
            return this.getEmptyDB(dbIndex);
        }
    }

    writeDatabase(dbIndex, data) {
        try {
            fs.writeFileSync(this.dbPaths[dbIndex], JSON.stringify(data, null, 2));
            return true;
        } catch (error) {
            console.error(`❌ Error writing database ${dbIndex}:`, error);
            return false;
        }
    }

    getEmptyDB(dbIndex) {
        if (dbIndex === 0) return { settings: {}, admin: {}, groups: [], pendingGroups: [] };
        if (dbIndex === 1) return { membershipChecks: {} };
        if (dbIndex >= 2 && dbIndex <= 4) return { users: {}, statistics: { totalUsers: 0, usersToday: 0, lastReset: '' } };
        if (dbIndex === 5) return { trades: {} };
        if (dbIndex === 6) return { wallets: {}, withdrawals: {}, withdrawalAccounts: {} };
        if (dbIndex === 7) return { tickets: [], chatLogs: {} };
        return {};
    }

    // ── USER CRUD ────────────────────────────────────────────────────
    getUser(userId) {
        if (userId === ADMIN_CHAT_ID) {
            const adminDb = this.readDatabase(0);
            return adminDb.users ? adminDb.users[userId] : null;
        }
        for (let i = 2; i <= 4; i++) {
            const db = this.readDatabase(i);
            if (db.users && db.users[userId]) return db.users[userId];
        }
        return null;
    }

    createOrUpdateUser(userId, userData) {
        if (userId === ADMIN_CHAT_ID) {
            const adminDb = this.readDatabase(0);
            adminDb.users = adminDb.users || {};
            adminDb.users[userId] = { ...adminDb.users[userId], ...userData };
            return this.writeDatabase(0, adminDb);
        }
        const dbPath = this.getDatabasePath(userId);
        const dbIndex = this.dbPaths.indexOf(dbPath);
        const db = this.readDatabase(dbIndex);
        const isNewUser = !db.users[userId];
        if (isNewUser) {
            db.users[userId] = {
                id: userId, firstName: '', lastName: '', email: '', phone: '',
                createdAt: new Date().toISOString(), lastLogin: new Date().toISOString(),
                profileCompleted: false, totalTrades: 0, winningTrades: 0, totalProfit: 0,
                ...userData
            };
            const today = new Date().toISOString().split('T')[0];
            if (db.statistics.lastReset !== today) { db.statistics.usersToday = 0; db.statistics.lastReset = today; }
            db.statistics.usersToday++;
            db.statistics.totalUsers++;
        } else {
            db.users[userId] = { ...db.users[userId], ...userData, lastLogin: new Date().toISOString() };
        }
        return this.writeDatabase(dbIndex, db);
    }

    deleteUser(userId) {
        let deleted = false;
        for (let i = 2; i <= 4; i++) {
            const db = this.readDatabase(i);
            if (db.users && db.users[userId]) {
                delete db.users[userId];
                db.statistics.totalUsers = Math.max(0, db.statistics.totalUsers - 1);
                this.writeDatabase(i, db);
                deleted = true;
            }
        }
        return deleted;
    }

    getAllUsers() {
        const allUsers = {};
        for (let i = 2; i <= 4; i++) {
            const db = this.readDatabase(i);
            if (db.users) Object.assign(allUsers, db.users);
        }
        return allUsers;
    }

    getTotalUserCount() {
        let total = 0;
        for (let i = 2; i <= 4; i++) { const db = this.readDatabase(i); total += db.statistics?.totalUsers || 0; }
        return total;
    }

    getTodayUsers() {
        let today = 0;
        const todayDate = new Date().toISOString().split('T')[0];
        for (let i = 2; i <= 4; i++) {
            const db = this.readDatabase(i);
            if (db.statistics?.lastReset === todayDate) today += db.statistics?.usersToday || 0;
        }
        return today;
    }

    // ── WALLET ───────────────────────────────────────────────────────
    getWallet(userId) {
        const db = this.readDatabase(6);
        return db.wallets?.[userId] || { USDT: 0 };
    }

    setWallet(userId, wallet) {
        const db = this.readDatabase(6);
        if (!db.wallets) db.wallets = {};
        db.wallets[userId] = wallet;
        return this.writeDatabase(6, db);
    }

    creditWallet(userId, amount) {
        const wallet = this.getWallet(userId);
        wallet.USDT = parseFloat(((wallet.USDT || 0) + amount).toFixed(2));
        return this.setWallet(userId, wallet);
    }

    debitWallet(userId, amount) {
        const wallet = this.getWallet(userId);
        if ((wallet.USDT || 0) < amount) return false;
        wallet.USDT = parseFloat((wallet.USDT - amount).toFixed(2));
        this.setWallet(userId, wallet);
        return true;
    }

    // ── WITHDRAWAL ACCOUNTS ──────────────────────────────────────────
    getWithdrawalAccounts(userId) {
        const db = this.readDatabase(6);
        return db.withdrawalAccounts?.[userId] || [];
    }

    addWithdrawalAccount(userId, account) {
        const db = this.readDatabase(6);
        if (!db.withdrawalAccounts) db.withdrawalAccounts = {};
        if (!db.withdrawalAccounts[userId]) db.withdrawalAccounts[userId] = [];
        const entry = {
            id: crypto.randomBytes(6).toString('hex'),
            bankName: account.bankName,
            accountNumber: account.accountNumber,
            accountName: account.accountName,
            type: account.type || 'bank',
            isDefault: db.withdrawalAccounts[userId].length === 0,
            addedAt: new Date().toISOString()
        };
        db.withdrawalAccounts[userId].push(entry);
        this.writeDatabase(6, db);
        return entry;
    }

    // ── WITHDRAWALS ──────────────────────────────────────────────────
    createWithdrawal(userId, amount, accountId, accountDetails) {
        const db = this.readDatabase(6);
        if (!db.withdrawals) db.withdrawals = {};
        if (!db.withdrawals[userId]) db.withdrawals[userId] = [];
        const entry = {
            id: 'WD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
            amount,
            accountId,
            accountDetails,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        db.withdrawals[userId].push(entry);
        this.writeDatabase(6, db);
        return entry;
    }

    getWithdrawals(userId) {
        const db = this.readDatabase(6);
        return (db.withdrawals?.[userId] || []).slice().reverse();
    }

    getAllWithdrawals() {
        const db = this.readDatabase(6);
        const all = [];
        Object.entries(db.withdrawals || {}).forEach(([userId, list]) => {
            list.forEach(w => all.push({ ...w, userId }));
        });
        return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    // ── TRADE HISTORY ────────────────────────────────────────────────
    addTrade(userId, trade) {
        const db = this.readDatabase(5);
        if (!db.trades) db.trades = {};
        if (!db.trades[userId]) db.trades[userId] = [];
        db.trades[userId].unshift(trade);
        if (db.trades[userId].length > 500) db.trades[userId] = db.trades[userId].slice(0, 500);
        this.writeDatabase(5, db);
        return trade;
    }

    getTrades(userId, limit = 100) {
        const db = this.readDatabase(5);
        return (db.trades?.[userId] || []).slice(0, limit);
    }

    getAllTradeCount() {
        const db = this.readDatabase(5);
        return Object.values(db.trades || {}).reduce((sum, arr) => sum + arr.length, 0);
    }

    // ── SETTINGS ─────────────────────────────────────────────────────
    getSettings() {
        const db = this.readDatabase(0);
        return db.settings || {};
    }

    updateSettings(settings) {
        const db = this.readDatabase(0);
        db.settings = { ...db.settings, ...settings };
        return this.writeDatabase(0, db);
    }

    // ── SPONSOR GROUPS ───────────────────────────────────────────────
    addGroup(groupData) {
        const db = this.readDatabase(0);
        if (!db.groups) db.groups = [];
        if (!db.groups.find(g => g.id === groupData.id)) {
            db.groups.push({ ...groupData, addedAt: new Date().toISOString(), isActive: true });
            return this.writeDatabase(0, db);
        }
        return false;
    }

    getGroups() { return this.readDatabase(0).groups || []; }

    removeGroup(groupId) {
        const db = this.readDatabase(0);
        if (!db.groups) return false;
        const before = db.groups.length;
        db.groups = db.groups.filter(g => g.id !== groupId);
        if (db.groups.length !== before) return this.writeDatabase(0, db);
        return false;
    }

    addPendingGroup(groupData) {
        const db = this.readDatabase(0);
        if (!db.pendingGroups) db.pendingGroups = [];
        if (!db.pendingGroups.find(g => g.id === groupData.id)) {
            db.pendingGroups.push({ ...groupData, detectedAt: new Date().toISOString(), status: 'pending' });
            return this.writeDatabase(0, db);
        }
        return false;
    }

    getPendingGroups() { return this.readDatabase(0).pendingGroups || []; }

    approveGroup(groupId) {
        const db = this.readDatabase(0);
        if (!db.pendingGroups) return false;
        const pg = db.pendingGroups.find(g => g.id === groupId);
        if (pg) {
            db.pendingGroups = db.pendingGroups.filter(g => g.id !== groupId);
            if (!db.groups) db.groups = [];
            db.groups.push({ ...pg, addedAt: new Date().toISOString(), isActive: true });
            return this.writeDatabase(0, db);
        }
        return false;
    }

    rejectGroup(groupId) {
        const db = this.readDatabase(0);
        if (!db.pendingGroups) return false;
        const before = db.pendingGroups.length;
        db.pendingGroups = db.pendingGroups.filter(g => g.id !== groupId);
        if (db.pendingGroups.length !== before) return this.writeDatabase(0, db);
        return false;
    }

    updateUserMembership(userId, isMember) {
        const db = this.readDatabase(1);
        if (!db.membershipChecks) db.membershipChecks = {};
        db.membershipChecks[userId] = { isMember, lastChecked: new Date().toISOString() };
        this.writeDatabase(1, db);
        const user = this.getUser(userId);
        if (user) this.createOrUpdateUser(userId, { hasAccess: isMember });
    }

    // ── DROPBOX BACKUP ───────────────────────────────────────────────
    async backupAllDatabasesToDropbox(dbx) {
        try {
            const backupFolder = `/${SHORT_DOMAIN}`;
            try { await dbx.filesCreateFolderV2({ path: backupFolder }); } catch (e) { if (e.status !== 409) throw e; }
            const results = [];
            for (let i = 0; i < this.dbPaths.length; i++) {
                if (fs.existsSync(this.dbPaths[i])) {
                    const dbBuffer = fs.readFileSync(this.dbPaths[i]);
                    const fileName = path.basename(this.dbPaths[i]);
                    await dbx.filesUpload({ path: `${backupFolder}/${fileName}`, contents: dbBuffer, mode: { '.tag': 'overwrite' } });
                    results.push({ db: fileName, status: 'success' });
                }
            }
            return { success: true, results };
        } catch (error) {
            console.error('❌ Backup failed:', error);
            return { success: false, error: error.message };
        }
    }

    async restoreAllDatabasesFromDropbox(dbx) {
        try {
            const backupFolder = `/${SHORT_DOMAIN}`;
            const files = await dbx.filesListFolder({ path: backupFolder });
            let restored = 0;
            for (const file of files.result.entries) {
                if (file.name.endsWith('.json')) {
                    const download = await dbx.filesDownload({ path: `${backupFolder}/${file.name}` });
                    const filePath = path.join(__dirname, file.name);
                    fs.writeFileSync(filePath, download.result.fileBinary);
                    restored++;
                }
            }
            return restored > 0;
        } catch (error) {
            if (error.status === 409) return false;
            console.error('❌ Restore failed:', error);
            return false;
        }
    }
}

const multiDB = new MultiDatabase();

// ==================== DROPBOX ====================
const DROPBOX_APP_KEY = 'ho5ep3i58l3tvgu';
const DROPBOX_APP_SECRET = '9fy0w0pgaafyk3e';
const DROPBOX_REFRESH_TOKEN = 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3';

const config = {
    telegramBotToken: '8612910038:AAG0bo52GhFW9amqYKmSLYtFudGfAgMbup8',
    webPort: PORT,
    webBaseUrl: HEROKU_DOMAIN,
    maxMemoryMB: 450,
    backupInterval: 30 * 60 * 1000,  // 30 min — matches Heroku best practice
    cleanupInterval: 30 * 60 * 1000
};

let dbx = null;
let isDropboxInitialized = false;

async function getDropboxAccessToken() {
    try {
        if (!DROPBOX_REFRESH_TOKEN) return null;
        const response = await axios.post('https://api.dropbox.com/oauth2/token',
            new URLSearchParams({ grant_type: 'refresh_token', refresh_token: DROPBOX_REFRESH_TOKEN, client_id: DROPBOX_APP_KEY, client_secret: DROPBOX_APP_SECRET }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
        );
        if (!response.data.access_token) throw new Error('No access token');
        return response.data.access_token;
    } catch (error) {
        console.error('❌ Failed to get Dropbox token:', error.message);
        return null;
    }
}

async function initializeDropbox() {
    try {
        if (isDropboxInitialized && dbx) return dbx;
        const accessToken = await getDropboxAccessToken();
        if (!accessToken) return null;
        dbx = new Dropbox({ accessToken, clientId: DROPBOX_APP_KEY });
        await dbx.usersGetCurrentAccount();
        isDropboxInitialized = true;
        return dbx;
    } catch (error) {
        console.error('❌ Dropbox init failed:', error.message);
        return null;
    }
}

async function backupDatabaseToDropbox() {
    try {
        if (!dbx) { await initializeDropbox(); if (!dbx) return { success: false, error: 'Dropbox not configured' }; }
        return await multiDB.backupAllDatabasesToDropbox(dbx);
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function restoreDatabaseFromDropbox() {
    try {
        if (!dbx) { await initializeDropbox(); if (!dbx) return false; }
        return await multiDB.restoreAllDatabasesFromDropbox(dbx);
    } catch (error) {
        return false;
    }
}

// ==================== HELPERS ====================
function getUser(userId) { return multiDB.getUser(userId); }
function isAdmin(userId) { return userId.toString() === ADMIN_CHAT_ID.toString(); }
function getGroups() { return multiDB.getGroups(); }
function getPendingGroups() { return multiDB.getPendingGroups(); }

function getStatistics() {
    return {
        totalUsers: multiDB.getTotalUserCount(),
        usersToday: multiDB.getTodayUsers(),
        totalTrades: multiDB.getAllTradeCount(),
        domain: SHORT_DOMAIN
    };
}

// ==================== TRADE ENGINE ====================
// Binary options outcome resolution
// winRate in settings controls win probability (0–100, default 50)
function resolveTradeOutcome(userId, amount, direction, asset, duration) {
    const settings = multiDB.getSettings();
    const winRate = settings.winRate !== undefined ? settings.winRate : 50;
    const isWin = Math.random() * 100 < winRate;
    const payoutPct = settings.payoutPercentage || 86;
    const profit = isWin ? parseFloat((amount * payoutPct / 100).toFixed(2)) : -parseFloat(amount);
    return { isWin, profit, payoutPct };
}

// ==================== MEMORY MANAGEMENT ====================
const memoryCache = new NodeCache({ stdTTL: 300, checkperiod: 60, maxKeys: 100 });

function startMemoryCleanup() {
    setInterval(() => {
        const heapUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`🧠 Memory: ${heapUsedMB.toFixed(2)}MB`);
        if (heapUsedMB > config.maxMemoryMB * 0.7) {
            memoryCache.flushAll();
            if (global.gc) global.gc();
        }
    }, config.cleanupInterval);
}

function startAutoBackup() {
    // First backup 2 min after boot (let Dropbox initialise first)
    setTimeout(() => backupDatabaseToDropbox().catch(console.error), 2 * 60 * 1000);
    // Then every 30 minutes
    setInterval(() => {
        console.log('🔄 Auto-backup running...');
        backupDatabaseToDropbox().catch(err => console.error('Auto-backup failed:', err.message));
    }, config.backupInterval);
    console.log('🔄 Auto-backup started (every 30 minutes)');
}

// ==================== HEROKU AUTO-RESTART ====================
// Heroku dynos must restart every 24 h max. We restart every 14 h
// to stay within the window, always backing up first.
const RESTART_INTERVAL = 14 * 60 * 60 * 1000; // 14 hours
let restartTimer = null;

async function performHerokuRestart() {
    console.log('🔄 Scheduled Heroku restart — backing up first...');
    try {
        await backupDatabaseToDropbox();
        await new Promise(resolve => setTimeout(resolve, 3000)); // let Dropbox finish
    } catch (err) {
        console.error('❌ Pre-restart backup error:', err.message);
    }
    console.log('🚀 Restarting now (exit 143)...');
    process.exit(143); // 143 = SIGTERM exit code, Heroku will restart the dyno
}

function startHerokuRestart() {
    restartTimer = setInterval(() => {
        console.log('⏰ 14 hours elapsed — initiating scheduled restart...');
        performHerokuRestart();
    }, RESTART_INTERVAL);
    console.log('🔄 Heroku auto-restart configured (every 14 hours)');
}

// ==================== EXPRESS APP ====================
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, user-id');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ==================== PAGE ROUTES ====================

app.get('/ping', (req, res) => res.json({ status: 'ok', service: 'PRIMETRADE', timestamp: new Date().toISOString() }));

app.get('/health', (req, res) => {
    const heapUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;
    res.json({ status: 'healthy', memory: `${heapUsedMB.toFixed(2)}MB`, uptime: process.uptime(), timestamp: new Date().toISOString(), totalUsers: multiDB.getTotalUserCount() });
});

// Landing / home
app.get('/', (req, res) => {
    const landingPath = path.join(__dirname, 'landing.html');
    if (fs.existsSync(landingPath)) return res.sendFile(landingPath);
    res.json({ status: 'Primetrade Online', totalUsers: multiDB.getTotalUserCount(), uptime: process.uptime() });
});

// Registration page
app.get('/register/:userId', (req, res) => {
    const user = getUser(req.params.userId);
    if (user && user.profileCompleted) return res.redirect(`/dashboard/${req.params.userId}`);
    res.sendFile(path.join(__dirname, 'landing.html'));
});

// Dashboard
app.get('/webapp/:userId', (req, res) => {
    if (isAdmin(req.params.userId)) return res.redirect(`/admin-panel/${req.params.userId}`);
    const user = getUser(req.params.userId);
    if (!user || !user.profileCompleted) return res.redirect(`/register/${req.params.userId}`);
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard/:userId', (req, res) => {
    if (isAdmin(req.params.userId)) return res.redirect(`/admin-panel/${req.params.userId}`);
    const user = getUser(req.params.userId);
    if (!user || !user.profileCompleted) return res.redirect(`/register/${req.params.userId}`);
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Admin panel
app.get('/admin-panel/:userId', (req, res) => {
    if (!isAdmin(req.params.userId)) return res.redirect(`/dashboard/${req.params.userId}`);
    const adminPath = path.join(__dirname, 'admin.html');
    if (fs.existsSync(adminPath)) return res.sendFile(adminPath);
    res.json({ status: 'Admin panel not found', userId: req.params.userId });
});

// ==================== USER API ====================

// GET user with wallet
app.get('/api/user/:userId', (req, res) => {
    const { userId } = req.params;
    const user = getUser(userId);
    if (!user) return res.json({ success: false, error: 'User not found' });
    const wallet = multiDB.getWallet(userId);
    res.json({
        success: true,
        user: {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phone: user.phone || '',
            profileCompleted: user.profileCompleted,
            createdAt: user.createdAt,
            totalTrades: user.totalTrades || 0,
            winningTrades: user.winningTrades || 0,
            totalProfit: user.totalProfit || 0,
            wallet,
            isAdmin: isAdmin(userId)
        }
    });
});

// PUT update profile
app.put('/api/user/:userId', (req, res) => {
    const { userId } = req.params;
    const { firstName, lastName, email, phone } = req.body;
    const user = getUser(userId);
    if (!user) return res.json({ success: false, error: 'User not found' });
    const success = multiDB.createOrUpdateUser(userId, {
        firstName: firstName || user.firstName,
        lastName: lastName || user.lastName,
        email: email || user.email,
        phone: phone || user.phone || '',
        lastUpdated: new Date().toISOString()
    });
    res.json({ success: !!success });
});

// POST register / create account
app.post('/api/register/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const { firstName, lastName, email, phone } = req.body;

        if (!firstName || !lastName || !email) {
            return res.json({ success: false, error: 'First name, last name and email are required' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.json({ success: false, error: 'Invalid email address' });
        }

        const existing = getUser(userId);
        if (existing && existing.profileCompleted) {
            return res.json({
                success: true,
                user: { ...existing, wallet: multiDB.getWallet(userId) },
                message: 'Account already exists'
            });
        }

        multiDB.createOrUpdateUser(userId, {
            id: userId, firstName, lastName, email, phone: phone || '',
            profileCompleted: true, hasAccess: true,
            createdAt: new Date().toISOString()
        });

        // Start with $0 — admin credits manually or via Selar webhook
        multiDB.setWallet(userId, { USDT: 0 });

        const newUser = getUser(userId);

        if (bot) {
            bot.telegram.sendMessage(ADMIN_CHAT_ID,
                `👤 *New Registration*\n📛 ${firstName} ${lastName}\n📧 ${email}\n🆔 ${userId}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

        res.json({
            success: true,
            message: 'Account created successfully!',
            redirectUrl: `/dashboard/${userId}`,
            user: { ...newUser, wallet: multiDB.getWallet(userId) }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.json({ success: false, error: 'Internal server error' });
    }
});

// ==================== TRADING API ====================

// POST place a trade
app.post('/api/trade/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const { asset, direction, amount, duration } = req.body;

        const user = getUser(userId);
        if (!user) return res.json({ success: false, error: 'User not found' });

        const settings = multiDB.getSettings();
        const minAmount = settings.minTradeAmount || 3;

        if (!asset || !direction || !amount || !duration) {
            return res.json({ success: false, error: 'Missing required fields: asset, direction, amount, duration' });
        }
        if (!['call', 'put'].includes(direction)) {
            return res.json({ success: false, error: 'Direction must be call or put' });
        }
        if (parseFloat(amount) < minAmount) {
            return res.json({ success: false, error: `Minimum trade amount is $${minAmount}` });
        }

        const wallet = multiDB.getWallet(userId);
        if ((wallet.USDT || 0) < parseFloat(amount)) {
            return res.json({ success: false, error: 'Insufficient balance. Please fund your account.' });
        }

        // Debit stake immediately
        multiDB.debitWallet(userId, parseFloat(amount));

        // Resolve outcome
        const { isWin, profit, payoutPct } = resolveTradeOutcome(userId, parseFloat(amount), direction, asset, parseInt(duration));

        const tradeId = 'TR-' + crypto.randomBytes(5).toString('hex').toUpperCase();
        const openTime = new Date().toISOString();

        const trade = {
            id: tradeId,
            asset,
            direction,
            amount: parseFloat(amount),
            duration: parseInt(duration),
            openTime,
            closeTime: new Date(Date.now() + parseInt(duration) * 60 * 1000).toISOString(),
            result: isWin ? 'win' : 'loss',
            profit: isWin ? profit : -parseFloat(amount),
            payoutPct,
            status: 'closed',
            timestamp: openTime
        };

        // Credit winnings if won (stake + profit)
        if (isWin) {
            multiDB.creditWallet(userId, parseFloat(amount) + profit);
        }

        // Save trade
        multiDB.addTrade(userId, trade);

        // Update user stats
        multiDB.createOrUpdateUser(userId, {
            totalTrades: (user.totalTrades || 0) + 1,
            winningTrades: (user.winningTrades || 0) + (isWin ? 1 : 0),
            totalProfit: parseFloat(((user.totalProfit || 0) + trade.profit).toFixed(2))
        });

        const updatedWallet = multiDB.getWallet(userId);

        // Notify admin
        if (bot) {
            bot.telegram.sendMessage(ADMIN_CHAT_ID,
                `📊 *Trade*\n👤 ${user.firstName} ${user.lastName} (${userId})\n🎯 ${asset} ${direction.toUpperCase()} $${amount} × ${duration}m\n${isWin ? '✅ WIN +$' + profit : '❌ LOSS -$' + amount}\n💰 Balance: $${updatedWallet.USDT.toFixed(2)}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

        res.json({
            success: true,
            tradeId,
            predictedResult: isWin ? 'win' : 'loss',
            profit: trade.profit,
            payoutPct,
            newBalance: updatedWallet.USDT,
            trade
        });
    } catch (error) {
        console.error('Trade error:', error);
        res.json({ success: false, error: 'Trade processing failed' });
    }
});

// GET trade history
app.get('/api/trade-history/:userId', (req, res) => {
    const user = getUser(req.params.userId);
    if (!user) return res.json({ success: false, error: 'User not found' });
    const limit = parseInt(req.query.limit) || 100;
    const trades = multiDB.getTrades(req.params.userId, limit);
    res.json({ success: true, trades, total: trades.length });
});

// ==================== WALLET API ====================

// GET wallet balance
app.get('/api/wallet/:userId', (req, res) => {
    const user = getUser(req.params.userId);
    if (!user) return res.json({ success: false, error: 'User not found' });
    res.json({ success: true, wallet: multiDB.getWallet(req.params.userId) });
});

// ==================== PAYMENT KEYS (hardcoded) ====================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || 'sk_live_4a90c6a7dd045b4599b1ea23d529f99f57592e6c';
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || 'pk_live_7c6a7351e3a588d6997a976e7a88e67fd8189d17';
const USD_TO_NGN     = parseFloat(process.env.USD_TO_NGN || '1500');

const PAYSCRIBE_API_KEY        = process.env.PAYSCRIBE_API_KEY        || 'pk_live_6bbce4528087f8f3911e8f86b89d1ddd';
const PAYSCRIBE_WEBHOOK_SECRET = process.env.PAYSCRIBE_WEBHOOK_SECRET || 'ps_live_3465f4ef9516491c30b8f7b5e349dae7a96f0c1f588081264ddb0be03ee09fb7';
const PAYSCRIBE_WEBHOOK_IP     = process.env.PAYSCRIBE_WEBHOOK_IP     || '162.254.34.78';
const PAYSCRIBE_BASE           = 'https://api.payscribe.ng/api/v1';

// Helper: get real client IP behind Render/Heroku proxy
function getClientIP(req) {
    const fwd = req.headers['x-forwarded-for'];
    return fwd ? fwd.split(',')[0].trim() : (req.socket?.remoteAddress || '');
}

// POST /api/paystack/initialize
app.post('/api/paystack/initialize', async (req, res) => {
    try {
        const { userId, amountUSD, email } = req.body;
        if (!userId || !amountUSD || !email)
            return res.json({ success: false, error: 'userId, amountUSD and email are required' });
        const user = getUser(userId);
        if (!user) return res.json({ success: false, error: 'User not found' });
        if (!PAYSTACK_SECRET)
            return res.json({ success: false, error: 'Paystack not configured. Contact support.' });

        const amountNGN  = Math.round(parseFloat(amountUSD) * USD_TO_NGN);
        const amountKobo = amountNGN * 100;
        const reference  = 'PT_' + userId + '_' + Date.now();

        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email, amount: amountKobo, reference, currency: 'NGN',
                metadata: {
                    userId, amountUSD: parseFloat(amountUSD), amountNGN,
                    custom_fields: [
                        { display_name: 'PrimeTrade User', variable_name: 'userId', value: userId },
                        { display_name: 'USD Amount', variable_name: 'amountUSD', value: String(amountUSD) }
                    ]
                },
                callback_url: config.webBaseUrl + '/api/paystack/callback'
            },
            { headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET, 'Content-Type': 'application/json' }, timeout: 15000 }
        );

        const data = response.data && response.data.data;
        if (!data) return res.json({ success: false, error: 'Paystack initialization failed' });

        console.log('Paystack initialized: ' + reference + ' | $' + amountUSD + ' = N' + amountNGN);
        res.json({ success: true, authorization_url: data.authorization_url, access_code: data.access_code, reference: data.reference, amountNGN, amountUSD: parseFloat(amountUSD) });
    } catch (error) {
        console.error('Paystack init error:', error.response && error.response.data || error.message);
        res.json({ success: false, error: 'Payment initialization failed. Try again.' });
    }
});

// GET /api/paystack/callback — redirect after payment
app.get('/api/paystack/callback', async (req, res) => {
    const ref = req.query.reference || req.query.trxref;
    if (!ref) return res.redirect(config.webBaseUrl + '/dashboard/unknown?payment=failed');
    try {
        const result = await verifyPaystackTransaction(ref);
        const userId = result.userId || ref.split('_')[1] || 'unknown';
        if (result.success) res.redirect(config.webBaseUrl + '/dashboard/' + userId + '?payment=success&amount=' + result.amountUSD);
        else res.redirect(config.webBaseUrl + '/dashboard/' + userId + '?payment=failed');
    } catch { res.redirect(config.webBaseUrl + '/?payment=failed'); }
});

// POST /api/paystack/verify — called by frontend after inline popup
app.post('/api/paystack/verify', async (req, res) => {
    const { reference } = req.body;
    if (!reference) return res.json({ success: false, error: 'Reference required' });
    res.json(await verifyPaystackTransaction(reference));
});

// POST /api/paystack/webhook — Paystack server-to-server event
app.post('/api/paystack/webhook', async (req, res) => {
    const hash = require('crypto').createHmac('sha512', PAYSTACK_SECRET).update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) return res.sendStatus(401);
    res.sendStatus(200);
    if (req.body.event === 'charge.success') {
        const ref = req.body.data && req.body.data.reference;
        if (ref) verifyPaystackTransaction(ref).catch(console.error);
    }
});

// Shared Paystack verification
async function verifyPaystackTransaction(reference) {
    try {
        const response = await axios.get(
            'https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference),
            { headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET }, timeout: 15000 }
        );
        const data = response.data && response.data.data;
        if (!data || data.status !== 'success') return { success: false, error: 'Transaction not successful' };

        const userId    = data.metadata && data.metadata.userId;
        const amountUSD = parseFloat(data.metadata && data.metadata.amountUSD || 0);
        const amountNGN = data.amount / 100;
        if (!userId || amountUSD <= 0) return { success: false, error: 'Invalid metadata' };

        // Dedup check
        const db = multiDB.readDatabase(1);
        if (!db.processedPayments) db.processedPayments = {};
        if (db.processedPayments[reference]) return { success: true, duplicate: true, userId, amountUSD };

        multiDB.creditWallet(userId, amountUSD);
        db.processedPayments[reference] = { userId, amountUSD, amountNGN, processedAt: new Date().toISOString() };
        multiDB.writeDatabase(1, db);

        const newBalance = multiDB.getWallet(userId).USDT;
        const user = getUser(userId);
        console.log('Wallet credited: ' + userId + ' +$' + amountUSD + ' via Paystack | Balance: $' + newBalance);

        if (bot && user) {
            bot.telegram.sendMessage(userId,
                '*Payment Received!*\n\nYour account has been funded with *$' + amountUSD.toFixed(2) + '* (\u20a6' + amountNGN.toLocaleString() + ') via Paystack.\n\n*New balance: $' + newBalance.toFixed(2) + '*\nRef: ' + reference,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
            bot.telegram.sendMessage(ADMIN_CHAT_ID,
                '*Paystack Payment*\n' + (user.firstName || '') + ' ' + (user.lastName || '') + ' (' + userId + ')\n$' + amountUSD + ' (\u20a6' + amountNGN.toLocaleString() + ')\nRef: ' + reference + '\nBalance: $' + newBalance.toFixed(2),
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
        return { success: true, userId, amountUSD, amountNGN, newBalance };
    } catch (error) {
        console.error('Paystack verify error:', error.response && error.response.data || error.message);
        return { success: false, error: 'Verification failed' };
    }
}

// GET /api/paystack/public-key — safely expose public key to frontend
app.get('/api/paystack/public-key', (req, res) => {
    if (!PAYSTACK_PUBLIC) return res.json({ success: false, error: 'Paystack not configured' });
    res.json({ success: true, publicKey: PAYSTACK_PUBLIC });
});

// ==================== PAYSCRIBE STABLECOIN ====================

// GET /api/stable/currencies — proxy supported currencies to frontend
app.get('/api/stable/currencies', async (req, res) => {
    try {
        const r = await axios.get(PAYSCRIBE_BASE + '/stable/addresses/currencies', {
            headers: { Authorization: 'Bearer ' + PAYSCRIBE_API_KEY }, timeout: 10000
        });
        res.json({ success: true, currencies: r.data?.message?.details || [] });
    } catch (err) {
        console.error('Payscribe currencies error:', err.response?.data || err.message);
        res.json({ success: false, error: 'Could not fetch supported currencies' });
    }
});

// ==================== PAYSTACK FUNDING ====================

app.post('/api/fund/paystack/init', async (req, res) => {
    try {
        const { userId, amountUSD, email } = req.body;
        if (!userId || !amountUSD || !email)
            return res.json({ success: false, error: 'userId, amountUSD and email are required' });
        const user = getUser(userId);
        if (!user) return res.json({ success: false, error: 'User not found' });

        const settings  = multiDB.getSettings();
        const usdToNgn  = settings.usdToNgn || USD_TO_NGN;
        const amountNGN  = Math.round(parseFloat(amountUSD) * usdToNgn);
        const amountKobo = amountNGN * 100;
        const reference  = 'PT_' + userId + '_' + Date.now();
        const baseUrl    = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);

        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email, amount: amountKobo, reference, currency: 'NGN',
            callback_url: baseUrl + '/api/fund/paystack/verify/' + reference,
            metadata: { userId, amountUSD: parseFloat(amountUSD), amountNGN, source: 'primetrade_funding' }
        }, { headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET, 'Content-Type': 'application/json' }, timeout: 15000 });

        if (response.data.status) {
            const db = multiDB.readDatabase(1);
            if (!db.pendingPaystack) db.pendingPaystack = {};
            db.pendingPaystack[reference] = { userId, amountUSD: parseFloat(amountUSD), amountNGN, email, createdAt: new Date().toISOString() };
            multiDB.writeDatabase(1, db);
            console.log('Paystack init: ' + reference + ' | $' + amountUSD + ' = ₦' + amountNGN + ' for ' + userId);
            res.json({ success: true, authorization_url: response.data.data.authorization_url, reference, access_code: response.data.data.access_code, amountNGN, amountUSD: parseFloat(amountUSD) });
        } else {
            res.json({ success: false, error: 'Paystack init failed' });
        }
    } catch (error) {
        console.error('Paystack init error:', error.response?.data || error.message);
        res.json({ success: false, error: 'Paystack error: ' + (error.response?.data?.message || error.message) });
    }
});

app.post('/api/fund/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const body = req.body.toString();
        const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(body).digest('hex');
        if (hash !== req.headers['x-paystack-signature']) return res.status(400).send('Bad signature');
        const event = JSON.parse(body);
        if (event.event === 'charge.success') {
            const { reference, metadata, amount } = event.data;
            const userId = metadata?.userId;
            const amountNGN = amount / 100;
            if (userId) {
                const settings = multiDB.getSettings();
                const amountUSD = parseFloat((amountNGN / (settings.usdToNgn || USD_TO_NGN)).toFixed(2));
                const db = multiDB.readDatabase(1);
                if (!db.completedPaystack) db.completedPaystack = {};
                if (!db.completedPaystack[reference]) {
                    db.completedPaystack[reference] = true;
                    multiDB.writeDatabase(1, db);
                    multiDB.creditWallet(userId, amountUSD);
                    const newWallet = multiDB.getWallet(userId);
                    const user = getUser(userId);
                    console.log('✅ Paystack funded: +$' + amountUSD + ' for ' + userId);
                    if (bot && user) bot.telegram.sendMessage(userId, '💰 *Account Funded*\n\nCredited *$' + amountUSD.toFixed(2) + '* (₦' + amountNGN.toLocaleString() + ' via Paystack)\n\n💳 New balance: *$' + newWallet.USDT.toFixed(2) + '*', { parse_mode: 'Markdown' }).catch(() => {});
                    if (bot) bot.telegram.sendMessage(ADMIN_CHAT_ID, '💳 *Paystack*\n👤 ' + (user?.firstName || userId) + '\n💵 +$' + amountUSD + ' (₦' + amountNGN.toLocaleString() + ')\n🔖 ' + reference, { parse_mode: 'Markdown' }).catch(() => {});
                }
            }
        }
        res.sendStatus(200);
    } catch (error) { console.error('Paystack webhook error:', error); res.sendStatus(500); }
});

app.get('/api/fund/paystack/verify/:reference', async (req, res) => {
    const { reference } = req.params;
    try {
        const response = await axios.get('https://api.paystack.co/transaction/verify/' + reference, {
            headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET }, timeout: 15000
        });
        const data = response.data.data;
        const userId = data.metadata?.userId;
        if (data.status === 'success' && userId) {
            const settings = multiDB.getSettings();
            const amountUSD = parseFloat((data.amount / 100 / (settings.usdToNgn || USD_TO_NGN)).toFixed(2));
            const db = multiDB.readDatabase(1);
            if (!db.completedPaystack) db.completedPaystack = {};
            if (!db.completedPaystack[reference]) {
                db.completedPaystack[reference] = true;
                multiDB.writeDatabase(1, db);
                multiDB.creditWallet(userId, amountUSD);
            }
            return res.redirect('/dashboard/' + userId + '?funded=1&amount=' + amountUSD);
        }
        res.redirect('/dashboard/' + (userId || '') + '?funded=0');
    } catch (error) { console.error('Paystack verify error:', error.message); res.redirect('/?funded=0'); }
});

app.get('/api/paystack/public-key', (req, res) => res.json({ success: true, publicKey: PAYSTACK_PUBLIC }));

// ==================== PAYSCRIBE STABLECOIN FUNDING ====================

async function ensurePayscribeCustomer(user, userId) {
    if (user.payscribeCustomerId) return user.payscribeCustomerId;
    const phone = (user.phone || '').replace(/\D/g, '') || '2340000000000';
    const r = await axios.post(PAYSCRIBE_BASE + '/customers/create', {
        first_name: user.firstName || 'User',
        last_name:  user.lastName  || userId,
        email:      user.email     || (userId + '@primetrade.app'),
        phone:      phone.startsWith('234') ? phone : '234' + phone,
        country:    'NG'
    }, { headers: { Authorization: 'Bearer ' + PAYSCRIBE_API_KEY, 'Content-Type': 'application/json' }, timeout: 15000 });
    const customerId = r.data?.message?.details?.customer_id;
    if (customerId) { multiDB.createOrUpdateUser(userId, { payscribeCustomerId: customerId }); return customerId; }
    throw new Error(r.data?.description || 'Failed to create Payscribe customer');
}

// POST /api/fund/payscribe/address — generate a deposit address for any supported currency+network
app.post('/api/fund/payscribe/address', async (req, res) => {
    try {
        const { userId, currency, network, chain } = req.body;
        if (!userId || !currency || !network || !chain)
            return res.json({ success: false, error: 'userId, currency, network and chain are required' });
        const user = getUser(userId);
        if (!user) return res.json({ success: false, error: 'User not found' });

        const customerId = await ensurePayscribeCustomer(user, userId);
        const r = await axios.post(PAYSCRIBE_BASE + '/stable/address/create', {
            currency, network, chain,
            label:       'PT_' + userId + '_' + currency,
            customer_id: customerId
        }, { headers: { Authorization: 'Bearer ' + PAYSCRIBE_API_KEY, 'Content-Type': 'application/json' }, timeout: 15000 });

        if (r.data?.status === true) {
            const d = r.data.message.details;
            console.log('Payscribe address: ' + d.address + ' (' + d.chain + ') for ' + userId);
            res.json({ success: true, address: d.address, network: d.network, chain: d.chain, currency: d.currency, memo_tag: d.memo_tag || null });
        } else {
            console.error('Payscribe address error:', r.data);
            res.json({ success: false, error: r.data?.description || 'Failed to generate address' });
        }
    } catch (error) {
        console.error('Payscribe address error:', error.response?.data || error.message);
        res.json({ success: false, error: 'Payscribe error: ' + (error.response?.data?.description || error.message) });
    }
});

// POST /api/fund/payscribe/webhook — IP-whitelisted + signed
app.post('/api/fund/payscribe/webhook', async (req, res) => {
    try {
        const clientIP = getClientIP(req);
        if (clientIP !== PAYSCRIBE_WEBHOOK_IP) {
            console.warn('⛔ Payscribe webhook blocked — IP: ' + clientIP);
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        const sigHeader = req.headers['x-payscribe-signature'] || req.headers['x-payscribe-secret'];
        if (PAYSCRIBE_WEBHOOK_SECRET && sigHeader) {
            const expected = crypto.createHmac('sha256', PAYSCRIBE_WEBHOOK_SECRET).update(JSON.stringify(req.body)).digest('hex');
            if (sigHeader !== expected) return res.status(401).json({ success: false, error: 'Invalid signature' });
        }
        const { event, data } = req.body;
        if (event === 'stablecoin.deposit' || event === 'transaction.success' || data?.status === 'success') {
            const userId    = data?.metadata?.userId || data?.customer_id;
            const amountUSD = parseFloat(data?.amount || data?.metadata?.amountUSD || 0);
            const txRef     = data?.tracking_id || data?.reference || data?.trans_id || ('PSC_' + Date.now());
            if (userId && amountUSD > 0) {
                const db = multiDB.readDatabase(1);
                if (!db.completedPayscribe) db.completedPayscribe = {};
                if (!db.completedPayscribe[txRef]) {
                    db.completedPayscribe[txRef] = true;
                    multiDB.writeDatabase(1, db);
                    multiDB.creditWallet(userId, amountUSD);
                    const newWallet = multiDB.getWallet(userId);
                    const user      = getUser(userId);
                    console.log('✅ Payscribe funded: +$' + amountUSD + ' for ' + userId);
                    if (bot && user) bot.telegram.sendMessage(userId, '💰 *Crypto Deposit Confirmed*\n\nCredited *$' + amountUSD.toFixed(2) + '* (' + (data?.currency || 'USDT') + ')\n\n💳 New balance: *$' + newWallet.USDT.toFixed(2) + '*', { parse_mode: 'Markdown' }).catch(() => {});
                    if (bot) bot.telegram.sendMessage(ADMIN_CHAT_ID, '💎 *Payscribe Deposit*\n👤 ' + (user?.firstName || userId) + '\n💵 +$' + amountUSD.toFixed(2) + ' ' + (data?.currency || 'USDT') + '\n🔖 ' + txRef, { parse_mode: 'Markdown' }).catch(() => {});
                }
            }
        }
        res.json({ success: true });
    } catch (error) { console.error('Payscribe webhook error:', error); res.sendStatus(500); }
});

// ==================== WITHDRAWAL API ====================

// GET withdrawal accounts
app.get('/api/withdrawal-accounts/:userId', (req, res) => {
    const user = getUser(req.params.userId);
    if (!user) return res.json({ success: false, error: 'User not found' });
    res.json({ success: true, accounts: multiDB.getWithdrawalAccounts(req.params.userId) });
});

// POST add withdrawal account
app.post('/api/add-withdrawal-account/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const user = getUser(userId);
        if (!user) return res.json({ success: false, error: 'User not found' });

        const { bankName, accountNumber, accountName, type } = req.body;
        if (!bankName || !accountNumber || !accountName) {
            return res.json({ success: false, error: 'bankName, accountNumber and accountName are required' });
        }
        if (accountNumber.length !== 10) {
            return res.json({ success: false, error: 'Account number must be 10 digits' });
        }

        const account = multiDB.addWithdrawalAccount(userId, { bankName, accountNumber, accountName, type });
        res.json({ success: true, account });
    } catch (error) {
        console.error('Add withdrawal account error:', error);
        res.json({ success: false, error: 'Failed to add account' });
    }
});

// POST request withdrawal
app.post('/api/request-withdrawal/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const { amount, accountId } = req.body;

        const user = getUser(userId);
        if (!user) return res.json({ success: false, error: 'User not found' });

        const settings = multiDB.getSettings();
        const minWithdrawal = settings.minWithdrawalAmount || 20;

        if (!amount || parseFloat(amount) < minWithdrawal) {
            return res.json({ success: false, error: `Minimum withdrawal is $${minWithdrawal}` });
        }

        const wallet = multiDB.getWallet(userId);
        if ((wallet.USDT || 0) < parseFloat(amount)) {
            return res.json({ success: false, error: 'Insufficient balance' });
        }

        if (!accountId) {
            return res.json({ success: false, error: 'No withdrawal account selected' });
        }

        const accounts = multiDB.getWithdrawalAccounts(userId);
        const account = accounts.find(a => a.id === accountId || a.accountNumber === accountId);
        if (!account) {
            return res.json({ success: false, error: 'Withdrawal account not found' });
        }

        // Debit balance
        multiDB.debitWallet(userId, parseFloat(amount));

        const withdrawal = multiDB.createWithdrawal(userId, parseFloat(amount), accountId, account);

        // Notify admin
        if (bot) {
            bot.telegram.sendMessage(ADMIN_CHAT_ID,
                `💸 *Withdrawal Request*\n👤 ${user.firstName} ${user.lastName} (${userId})\n💵 $${amount}\n🏦 ${account.bankName} — ${account.accountNumber} (${account.accountName})\n🆔 ${withdrawal.id}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

        // Notify user
        if (bot) {
            bot.telegram.sendMessage(userId,
                `📤 *Withdrawal Requested*\n\nAmount: *$${amount}*\nAccount: ${account.bankName} — ${account.accountNumber}\nRef: ${withdrawal.id}\n\nProcessing within 24 hours.`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

        res.json({
            success: true,
            message: 'Withdrawal request submitted! Processing within 24 hours.',
            withdrawal
        });
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.json({ success: false, error: 'Withdrawal processing failed' });
    }
});

// GET withdrawal history
app.get('/api/withdrawals/:userId', (req, res) => {
    const user = getUser(req.params.userId);
    if (!user) return res.json({ success: false, error: 'User not found' });
    res.json({ success: true, withdrawals: multiDB.getWithdrawals(req.params.userId) });
});

// ==================== ADMIN API ====================

app.get('/admin/statistics', (req, res) => {
    res.json({ success: true, statistics: getStatistics() });
});

app.get('/admin/users', (req, res) => {
    const users = Object.values(multiDB.getAllUsers()).map(u => ({
        id: u.id, firstName: u.firstName, lastName: u.lastName,
        email: u.email, phone: u.phone,
        profileCompleted: u.profileCompleted, createdAt: u.createdAt,
        totalTrades: u.totalTrades || 0, totalProfit: u.totalProfit || 0,
        wallet: multiDB.getWallet(u.id)
    }));
    res.json({ success: true, users, total: users.length });
});

app.delete('/admin/users/:userId', (req, res) => {
    const requesterId = req.headers['user-id'];
    if (!isAdmin(requesterId)) return res.status(403).json({ success: false, error: 'Access denied' });
    const { userId } = req.params;
    if (userId === ADMIN_CHAT_ID) return res.status(400).json({ success: false, error: 'Cannot delete admin' });
    const deleted = multiDB.deleteUser(userId);
    if (!deleted) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, message: `User ${userId} deleted` });
});

// Admin: view all withdrawals
app.get('/admin/withdrawals', (req, res) => {
    const requesterId = req.headers['user-id'];
    if (!isAdmin(requesterId)) return res.status(403).json({ success: false, error: 'Access denied' });
    res.json({ success: true, withdrawals: multiDB.getAllWithdrawals() });
});

// Admin: approve or reject a withdrawal
app.post('/admin/withdrawal/:withdrawalId/status', (req, res) => {
    const requesterId = req.headers['user-id'];
    if (!isAdmin(requesterId)) return res.status(403).json({ success: false, error: 'Access denied' });
    const { status, note } = req.body; // 'approved' | 'rejected'
    const { withdrawalId } = req.params;

    const db = multiDB.readDatabase(6);
    let found = false, targetUserId = null, targetWithdrawal = null;

    Object.entries(db.withdrawals || {}).forEach(([uid, list]) => {
        const wd = list.find(w => w.id === withdrawalId);
        if (wd) {
            wd.status = status;
            wd.note = note || '';
            wd.updatedAt = new Date().toISOString();
            found = true;
            targetUserId = uid;
            targetWithdrawal = wd;
            // Refund if rejected
            if (status === 'rejected') multiDB.creditWallet(uid, wd.amount);
        }
    });

    if (!found) return res.json({ success: false, error: 'Withdrawal not found' });
    multiDB.writeDatabase(6, db);

    if (bot && targetUserId) {
        const msg = status === 'approved'
            ? `✅ *Withdrawal Approved*\n\nYour withdrawal of *$${targetWithdrawal.amount}* has been approved.\nRef: ${withdrawalId}`
            : `❌ *Withdrawal Rejected*\n\nYour withdrawal of *$${targetWithdrawal.amount}* was rejected${note ? ': ' + note : ''}. Amount refunded.\nRef: ${withdrawalId}`;
        bot.telegram.sendMessage(targetUserId, msg, { parse_mode: 'Markdown' }).catch(() => {});
    }

    res.json({ success: true });
});

// Admin: credit a user's wallet
app.post('/admin/credit/:userId', (req, res) => {
    const requesterId = req.headers['user-id'];
    if (!isAdmin(requesterId)) return res.status(403).json({ success: false, error: 'Access denied' });
    const { amount } = req.body;
    const { userId } = req.params;
    if (!amount || parseFloat(amount) <= 0) return res.json({ success: false, error: 'Invalid amount' });

    multiDB.creditWallet(userId, parseFloat(amount));
    const newWallet = multiDB.getWallet(userId);

    const user = getUser(userId);
    if (bot && user) {
        bot.telegram.sendMessage(userId,
            `💰 *Account Credited*\n\nYour Primetrade account has been credited *$${parseFloat(amount).toFixed(2)}*.\n\n💳 New balance: *$${newWallet.USDT.toFixed(2)}*`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }

    res.json({ success: true, newBalance: newWallet.USDT });
});

// Admin: get/update platform settings
app.get('/admin/settings', (req, res) => {
    res.json({ success: true, settings: multiDB.getSettings() });
});

app.post('/admin/settings', (req, res) => {
    const requesterId = req.headers['user-id'];
    if (!isAdmin(requesterId)) return res.status(403).json({ success: false, error: 'Access denied' });
    multiDB.updateSettings(req.body);
    res.json({ success: true, settings: multiDB.getSettings() });
});

// Backup routes
app.get('/trigger-backup', async (req, res) => {
    const r = await backupDatabaseToDropbox();
    res.json(r);
});

app.get('/backup-status', (req, res) => {
    res.json({
        success: true,
        databases: multiDB.dbPaths.map(p => ({
            name: path.basename(p),
            exists: fs.existsSync(p),
            size: fs.existsSync(p) ? fs.statSync(p).size : 0
        }))
    });
});

// Admin: groups/sponsors
app.get('/admin/groups', (req, res) => {
    res.json({ success: true, groups: multiDB.getGroups(), pending: multiDB.getPendingGroups() });
});
app.post('/admin/groups/approve', (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.json({ success: false, error: 'Missing groupId' });
    res.json({ success: multiDB.approveGroup(groupId) });
});
app.post('/admin/groups/reject', (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.json({ success: false, error: 'Missing groupId' });
    res.json({ success: multiDB.rejectGroup(groupId) });
});
app.delete('/admin/groups/remove', (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.json({ success: false, error: 'Missing groupId' });
    res.json({ success: multiDB.removeGroup(groupId) });
});

// ==================== TELEGRAM BOT ====================
let bot = null;

function ensureSession(ctx, next) { if (!ctx.session) ctx.session = {}; return next(); }

async function checkUserMembership(userId) {
    try {
        const groups = getGroups();
        if (groups.length === 0) { multiDB.updateUserMembership(userId, true); return { hasAccess: true, notJoinedGroups: [] }; }
        const notJoinedGroups = [];
        for (const group of groups) {
            try {
                if (!bot) { notJoinedGroups.push(group); continue; }
                const chatMember = await bot.telegram.getChatMember(group.id, userId);
                const valid = ['creator', 'administrator', 'member', 'restricted'].includes(chatMember.status);
                if (!valid) notJoinedGroups.push(group);
            } catch (_) { notJoinedGroups.push(group); }
            await new Promise(r => setTimeout(r, 500));
        }
        multiDB.updateUserMembership(userId, notJoinedGroups.length === 0);
        return { hasAccess: notJoinedGroups.length === 0, notJoinedGroups };
    } catch (error) {
        multiDB.updateUserMembership(userId, false);
        return { hasAccess: false, notJoinedGroups: getGroups() };
    }
}

async function handleAutoGroupDetection(ctx) {
    try {
        const chat = ctx.chat;
        if (!chat || !['group', 'supergroup', 'channel'].includes(chat.type)) return;
        if (ctx.message?.new_chat_members) {
            const botInfo = await bot.telegram.getMe();
            if (ctx.message.new_chat_members.some(m => m.id === botInfo.id)) {
                let inviteLink = null;
                try {
                    inviteLink = chat.type !== 'channel'
                        ? (await bot.telegram.createChatInviteLink(chat.id, { creates_join_request: false })).invite_link
                        : (chat.username ? `https://t.me/${chat.username}` : null);
                } catch (_) {}
                const groupData = { id: chat.id.toString(), title: chat.title || 'Unknown', username: chat.username, inviteLink, type: chat.type === 'channel' ? 'channel' : 'group' };
                if (multiDB.addPendingGroup(groupData)) {
                    await bot.telegram.sendMessage(ADMIN_CHAT_ID,
                        `🆕 *New ${chat.type} Detected*\n📝 ${chat.title}\n🆔 ${chat.id}\n🔗 ${inviteLink || 'N/A'}`,
                        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `approve_${chat.id}`)], [Markup.button.callback('❌ Reject', `reject_${chat.id}`)]])}
                    );
                }
            }
        }
        if (ctx.message?.left_chat_member) {
            const botInfo = await bot.telegram.getMe();
            if (ctx.message.left_chat_member.id === botInfo.id) {
                multiDB.removeGroup(chat.id.toString());
                multiDB.rejectGroup(chat.id.toString());
                await bot.telegram.sendMessage(ADMIN_CHAT_ID, `🚫 Bot removed from ${chat.title}`);
            }
        }
    } catch (_) {}
}

async function handleUserStart(ctx) {
    const userId = ctx.from.id.toString();
    let user = getUser(userId);
    if (!user) {
        user = { id: userId, firstName: ctx.from.first_name || '', lastName: ctx.from.last_name || '', telegramUsername: ctx.from.username || '', profileCompleted: false, hasAccess: false, createdAt: new Date().toISOString() };
        multiDB.createOrUpdateUser(userId, user);
    }

    const membershipCheck = await checkUserMembership(userId);
    if (!membershipCheck.hasAccess && getGroups().length > 0) {
        const groupButtons = membershipCheck.notJoinedGroups.map(g =>
            [Markup.button.url(`📢 Join ${g.title}`, g.inviteLink || `https://t.me/${g.username || ''}`)]
        );
        return ctx.reply('⚠️ Please join the required sponsor channels first.', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([...groupButtons, [Markup.button.callback('✅ I Joined — Check Access', 'check_access')]])
        });
    }

    if (!user.profileCompleted) {
        return ctx.reply(
            '👋 Welcome to *Primetrade*!\n\nCreate your account to start trading.',
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.webApp('📝 Create Account', `${config.webBaseUrl}/register/${userId}`)]]) }
        );
    }

    return ctx.reply(
        `🎯 Welcome back, *${user.firstName}*!\n\nYour trading dashboard is ready.`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.webApp('🚀 Open Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)]]) }
    );
}

async function handleAdminStart(ctx) {
    const stats = getStatistics();
    await ctx.reply(
        `👑 *Admin Panel — Primetrade*\n\n👥 Users: ${stats.totalUsers}\n📅 Today: ${stats.usersToday}\n📊 Total Trades: ${stats.totalTrades}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
            [Markup.button.webApp('📊 Admin Panel', `${config.webBaseUrl}/admin-panel/${ADMIN_CHAT_ID}`)],
            [Markup.button.callback('📈 Stats', 'admin_stats'), Markup.button.callback('👥 Users', 'admin_users')],
            [Markup.button.callback('💾 Backup', 'admin_backup')]
        ])}
    );
}

async function showStatistics(ctx) {
    const stats = getStatistics();
    await ctx.reply(
        `📊 *Primetrade Statistics*\n\n👥 Total Users: ${stats.totalUsers}\n📅 Today: ${stats.usersToday}\n📊 Total Trades: ${stats.totalTrades}`,
        { parse_mode: 'Markdown' }
    );
}

async function listUsers(ctx) {
    const users = Object.values(multiDB.getAllUsers()).slice(0, 10);
    const userList = users.map((u, i) =>
        `${i + 1}. ${u.firstName || 'Unknown'} ${u.lastName || ''}\n   📧 ${u.email || 'N/A'}\n   🆔 ${u.id}\n   💰 $${(multiDB.getWallet(u.id).USDT || 0).toFixed(2)}`
    ).join('\n\n');
    await ctx.reply(`👥 *Users (${multiDB.getTotalUserCount()} total)*\n\n${userList}`, { parse_mode: 'Markdown' });
}

async function triggerBackup(ctx) {
    await ctx.reply('🔄 Starting backup...');
    const r = await backupDatabaseToDropbox();
    await ctx.reply(r.success ? '✅ Backup completed!' : `❌ Backup failed: ${r.error}`);
}

async function initializeTelegramBot() {
    try {
        bot = new Telegraf(config.telegramBotToken);
        bot.use(session());
        bot.use(ensureSession);

        bot.start(async ctx => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) await handleAdminStart(ctx);
            else await handleUserStart(ctx);
        });

        bot.command('admin', async ctx => { if (isAdmin(ctx.from.id.toString())) await handleAdminStart(ctx); else await ctx.reply('❌ Access denied'); });
        bot.command('stats', async ctx => { if (isAdmin(ctx.from.id.toString())) await showStatistics(ctx); else await ctx.reply('❌ Access denied'); });
        bot.command('users', async ctx => { if (isAdmin(ctx.from.id.toString())) await listUsers(ctx); else await ctx.reply('❌ Access denied'); });
        bot.command('backup', async ctx => { if (isAdmin(ctx.from.id.toString())) await triggerBackup(ctx); else await ctx.reply('❌ Access denied'); });

        bot.command('pending', async ctx => {
            if (!isAdmin(ctx.from.id.toString())) return ctx.reply('❌ Access denied');
            const pg = getPendingGroups();
            if (pg.length === 0) return ctx.reply('📭 No pending groups');
            await ctx.reply(`⏳ *Pending (${pg.length}):*\n\n${pg.map((g, i) => `${i + 1}. ${g.title}\n   ID: ${g.id}`).join('\n')}`, { parse_mode: 'Markdown' });
        });

        bot.command('removechannel', async ctx => {
            if (!isAdmin(ctx.from.id.toString())) return ctx.reply('Access denied');
            const args = ctx.message.text.split(' ').slice(1);
            if (!args.length) {
                const groups = getGroups();
                if (!groups.length) return ctx.reply('No approved channels to remove.');
                return ctx.reply('Approved Channels:\n\n' + groups.map((g, i) => `${i + 1}. ${g.title}\n   ID: ${g.id}`).join('\n\n') + '\n\nUsage: /removechannel CHANNEL_ID');
            }
            const channelId = args[0].trim();
            const found = getGroups().find(g => g.id === channelId);
            if (!found) return ctx.reply('Channel ID ' + channelId + ' not found.');
            multiDB.removeGroup(channelId);
            await ctx.reply('Removed: ' + found.title);
        });

        bot.command('addchannel', async ctx => {
            if (!isAdmin(ctx.from.id.toString())) return ctx.reply('❌ Access denied');
            const args = ctx.message.text.split(' ').slice(1);
            if (args.length < 2) return ctx.reply('Usage: /addchannel CHANNEL_ID Channel Name');
            const [channelId, ...nameParts] = args;
            if (!channelId.startsWith('-100')) return ctx.reply('❌ Invalid Channel ID. Must start with -100');
            const success = multiDB.addGroup({ id: channelId, title: nameParts.join(' '), type: 'channel', isActive: true });
            await ctx.reply(success ? `✅ Added: ${nameParts.join(' ')}` : '⚠️ Channel already exists');
        });

        // Admin: /credit USER_ID AMOUNT
        bot.command('credit', async ctx => {
            if (!isAdmin(ctx.from.id.toString())) return ctx.reply('❌ Access denied');
            const args = ctx.message.text.split(' ').slice(1);
            if (args.length < 2) return ctx.reply('Usage: /credit USER_ID AMOUNT');
            const [targetUserId, amountStr] = args;
            const amount = parseFloat(amountStr);
            if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Invalid amount');
            const user = getUser(targetUserId);
            if (!user) return ctx.reply('❌ User not found');
            multiDB.creditWallet(targetUserId, amount);
            const wallet = multiDB.getWallet(targetUserId);
            await ctx.reply(`✅ Credited $${amount} to ${user.firstName} ${user.lastName}\n💰 New balance: $${wallet.USDT.toFixed(2)}`);
            bot.telegram.sendMessage(targetUserId,
                `💰 *Account Credited*\n\nYour Primetrade account has been credited *$${amount.toFixed(2)}*.\n\n💳 New balance: *$${wallet.USDT.toFixed(2)}*`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        });

        // Admin: /cryptoapprove DEPOSIT_ID — approve a pending crypto deposit
        bot.command('cryptoapprove', async ctx => {
            if (!isAdmin(ctx.from.id.toString())) return ctx.reply('Access denied');
            const args = ctx.message.text.split(' ').slice(1);
            if (!args[0]) return ctx.reply('Usage: /cryptoapprove DEPOSIT_ID');
            const depositId = args[0].trim();
            const db = multiDB.readDatabase(1);
            if (!db.cryptoDeposits) return ctx.reply('No pending deposits found');
            const dep = db.cryptoDeposits.find(d => d.id === depositId);
            if (!dep) return ctx.reply('Deposit ' + depositId + ' not found');
            if (dep.status === 'approved') return ctx.reply('Already approved');

            // Check duplicate tx
            if (!db.processedCrypto) db.processedCrypto = {};
            if (db.processedCrypto[dep.txHash]) return ctx.reply('TX already processed: ' + dep.txHash);

            dep.status = 'approved';
            dep.approvedAt = new Date().toISOString();
            db.processedCrypto[dep.txHash] = { userId: dep.userId, amountUSD: dep.amountUSD, processedAt: new Date().toISOString() };
            multiDB.writeDatabase(1, db);
            multiDB.creditWallet(dep.userId, dep.amountUSD);

            const newBalance = multiDB.getWallet(dep.userId).USDT;
            const user = getUser(dep.userId);
            await ctx.reply('Approved: ' + dep.userId + ' +$' + dep.amountUSD + ' | Balance: $' + newBalance.toFixed(2));
            bot.telegram.sendMessage(dep.userId,
                '*Crypto Deposit Confirmed!*\n\nYour USDT deposit of *$' + dep.amountUSD.toFixed(2) + '* has been confirmed.\n\nNew balance: *$' + newBalance.toFixed(2) + '*',
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        });

        // Admin: /cryptopending — list pending crypto deposits
        bot.command('cryptopending', async ctx => {
            if (!isAdmin(ctx.from.id.toString())) return ctx.reply('Access denied');
            const db = multiDB.readDatabase(1);
            const pending = (db.cryptoDeposits || []).filter(d => d.status === 'pending');
            if (!pending.length) return ctx.reply('No pending crypto deposits');
            const list = pending.map((d, i) => (i+1) + '. $' + d.amountUSD + ' USDT\n   User: ' + d.userId + '\n   TX: ' + d.txHash.substring(0,20) + '...\n   ID: ' + d.id).join('\n\n');
            await ctx.reply('Pending Crypto Deposits (' + pending.length + '):\n\n' + list);
        });

        // Admin: /debit USER_ID AMOUNT
        bot.command('debit', async ctx => {
            if (!isAdmin(ctx.from.id.toString())) return ctx.reply('❌ Access denied');
            const args = ctx.message.text.split(' ').slice(1);
            if (args.length < 2) return ctx.reply('Usage: /debit USER_ID AMOUNT');
            const [targetUserId, amountStr] = args;
            const amount = parseFloat(amountStr);
            if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Invalid amount');
            const user = getUser(targetUserId);
            if (!user) return ctx.reply('❌ User not found');
            const success = multiDB.debitWallet(targetUserId, amount);
            if (!success) return ctx.reply('❌ Insufficient balance');
            const wallet = multiDB.getWallet(targetUserId);
            await ctx.reply(`✅ Debited $${amount} from ${user.firstName} ${user.lastName}\n💰 New balance: $${wallet.USDT.toFixed(2)}`);
        });

        // Callbacks
        bot.action('check_access', async ctx => {
            await ctx.answerCbQuery('Checking...');
            const userId = ctx.from.id.toString();
            const check = await checkUserMembership(userId);
            if (check.hasAccess) await handleUserStart(ctx);
            else await ctx.reply('❌ You still need to join all required channels.');
        });

        bot.action(/^approve_(.+)$/, async ctx => {
            if (!isAdmin(ctx.from.id.toString())) return ctx.answerCbQuery('Access denied');
            await ctx.answerCbQuery('Approving...');
            const success = multiDB.approveGroup(ctx.match[1]);
            await ctx.editMessageText(success ? '✅ Sponsor approved!' : '❌ Failed to approve');
        });

        bot.action(/^reject_(.+)$/, async ctx => {
            if (!isAdmin(ctx.from.id.toString())) return ctx.answerCbQuery('Access denied');
            await ctx.answerCbQuery('Rejected');
            multiDB.rejectGroup(ctx.match[1]);
            await ctx.editMessageText('❌ Rejected');
        });

        bot.action('admin_stats', async ctx => { await ctx.answerCbQuery(); await showStatistics(ctx); });
        bot.action('admin_users', async ctx => { await ctx.answerCbQuery(); await listUsers(ctx); });
        bot.action('admin_backup', async ctx => { await ctx.answerCbQuery('Starting backup...'); await triggerBackup(ctx); });

        bot.on('new_chat_members', handleAutoGroupDetection);
        bot.on('left_chat_member', handleAutoGroupDetection);

        return bot;
    } catch (error) {
        console.error('❌ Bot init failed:', error);
        return null;
    }
}

// ==================== START ====================
async function startServers() {
    try {
        console.log('🚀 Starting Primetrade...');
        await restoreDatabaseFromDropbox();

        const server = app.listen(config.webPort, '0.0.0.0', () => {
            console.log(`✅ Web server running on port ${config.webPort}`);
            console.log(`📊 Dashboard: ${config.webBaseUrl}/dashboard/{userId}`);
        });

        startMemoryCleanup();
        startAutoBackup();

        // ── Heroku keep-alive ─────────────────────────────────────
        // Heroku free/eco dynos sleep after 30 min of inactivity.
        // Ping /ping every 25 min to prevent sleep.
        if (IS_HEROKU) {
            setInterval(() => {
                axios.get(`${config.webBaseUrl}/ping`, { timeout: 10000 })
                    .then(() => console.log('💓 Heroku keep-alive ping OK'))
                    .catch(() => {}); // silence network errors
            }, 25 * 60 * 1000); // every 25 minutes
            console.log('💓 Heroku keep-alive ping started (every 25 min)');
        }

        // ── Heroku auto-restart every 14 hours ───────────────────
        startHerokuRestart();

        const telegramBot = await initializeTelegramBot();
        if (telegramBot) {
            await telegramBot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
            await telegramBot.launch({ dropPendingUpdates: true });
            console.log('✅ Telegram bot started');
            try {
                await telegramBot.telegram.sendMessage(ADMIN_CHAT_ID,
                    `🎯 *Primetrade Started*\n🕒 ${new Date().toLocaleString()}\n🌐 ${config.webBaseUrl}\n☁️ Heroku Dyno: ${process.env.DYNO || 'local'}\n👥 Users: ${multiDB.getTotalUserCount()}`,
                    { parse_mode: 'Markdown' }
                );
            } catch (_) {}
        }

        // Heroku sends SIGTERM on dyno restart/shutdown; also handle SIGINT for local dev
        process.once('SIGTERM', () => gracefulShutdown(telegramBot, server));
        process.once('SIGINT',  () => gracefulShutdown(telegramBot, server));

    } catch (error) {
        console.error('❌ Failed to start:', error);
        process.exit(1);
    }
}

async function gracefulShutdown(telegramBot, server) {
    console.log('🛑 Graceful shutdown started — backing up...');
    if (restartTimer) clearInterval(restartTimer);
    await backupDatabaseToDropbox().catch(() => {});
    if (telegramBot) await telegramBot.stop('SIGTERM').catch(() => {});
    server.close(() => {
        console.log('✅ Shutdown complete');
        process.exit(0);
    });
    // Force-exit after 10 s if server doesn't close cleanly
    setTimeout(() => { console.log('⚠️  Force exit after timeout'); process.exit(0); }, 10000);
}

process.on('unhandledRejection', (reason) => console.error('❌ Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => { console.error('❌ Uncaught Exception:', error); process.exit(1); });

startServers();

module.exports = { multiDB, getUser, isAdmin, getStatistics, backupDatabaseToDropbox };
