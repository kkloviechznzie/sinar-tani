const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// --- 1. SETUP DATABASE ---
const db = new sqlite3.Database('./kmap.sqlite', (err) => {
    if (err) console.error("Database Error:", err.message);
    else console.log("Database terkoneksi...");
});

// Setup Tabel (User, Reports, Products, Proposals)
db.serialize(() => {
    // 1. Tabel Users (Dengan kolom lengkap untuk Profil)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        fullname TEXT,
        role TEXT DEFAULT 'user',
        bio TEXT,
        phone TEXT,
        photo TEXT
    )`);

    // MIGRASI MANUAL: Mencegah error jika tabel user lama belum punya kolom ini
    db.run("ALTER TABLE users ADD COLUMN bio TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN phone TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN photo TEXT", () => {});
    
    // 2. Tabel Reports (Fitur K-MAP)
    db.run(`CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        desa TEXT,
        kec TEXT,
        hama TEXT,
        status TEXT,
        lat REAL,
        lon REAL,
        foto TEXT,
        waktu TEXT,
        is_verified INTEGER DEFAULT 0
    )`);

    // 3. Tabel Products (Fitur SIPINTARSHOP)
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        seller_name TEXT,
        seller_phone TEXT,
        product_name TEXT,
        price REAL,
        description TEXT,
        photo TEXT,
        created_at TEXT
    )`);

    // 4. Tabel Proposals (Fitur SI-PEDULI / Bantuan Dinas) - BARU!
    db.run(`CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        type TEXT,
        amount TEXT,
        reason TEXT,
        status TEXT DEFAULT 'Pending',
        created_at TEXT
    )`);

    // Akun Admin Default (Password: admin123)
    const adminPass = bcrypt.hashSync("admin123", 10);
    db.run(`INSERT OR IGNORE INTO users (username, password, fullname, role) 
            VALUES ('admin', '${adminPass}', 'Administrator', 'admin')`);
});

// --- 2. MIDDLEWARE ---
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.set('view engine', 'ejs');

app.use(session({
    secret: 'rahasia_petani_sukses',
    resave: false,
    saveUninitialized: false
}));

// Setup Upload Foto
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

if (!fs.existsSync('./public/uploads')){
    fs.mkdirSync('./public/uploads', { recursive: true });
}

// Helper DB Async (Biar kodingan lebih rapi pakai await)
db.query = function (sql, params = []) {
    return new Promise((resolve, reject) => {
        this.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

// --- FUNGSI GEMBOK (AUTH) ---
function requireLogin(req, res, next) {
    if (req.session.user) next();
    else res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') next();
    else res.redirect('/');
}

// --- 3. ROUTE UTAMA ---

// Landing Page (Menu Utama)
app.get('/', requireLogin, (req, res) => {
    // Refresh data user dari DB agar foto/bio terbaru selalu muncul
    db.get("SELECT * FROM users WHERE id = ?", [req.session.user.id], (err, row) => {
        if (row) req.session.user = row;
        res.render('landing', { user: req.session.user });
    });
});

// Halaman Login
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { message: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.user = user;
            res.redirect('/'); 
        } else {
            res.render('login', { message: 'Username atau Password salah!' });
        }
    });
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Register
app.get('/register', (req, res) => {
    res.render('register', { message: null });
});

app.post('/register', async (req, res) => {
    const { fullname, username, password } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    const defaultPhoto = 'https://cdn-icons-png.flaticon.com/512/847/847969.png';
    
    db.run("INSERT INTO users (fullname, username, password, photo) VALUES (?,?,?,?)", 
        [fullname, username, hash, defaultPhoto], (err) => {
        if (err) res.render('register', { message: 'Username sudah digunakan!' });
        else res.render('login', { message: 'Registrasi Berhasil! Silakan Login.' });
    });
});

// --- FITUR 1: K-MAP (Radar Hama) ---
app.get('/dashboard', requireLogin, async (req, res) => {
    const user = req.session.user;
    let reports;
    
    // Admin lihat semua, User lihat yang verified + punya sendiri
    if (user.role === 'admin') {
        reports = await db.query("SELECT * FROM reports ORDER BY id DESC");
    } else {
        reports = await db.query("SELECT * FROM reports WHERE is_verified = 1 OR user_id = ? ORDER BY id DESC", [user.id]);
    }

    // Statistik Dashboard
    const total = await db.query("SELECT COUNT(*) as c FROM reports");
    const bahaya = await db.query("SELECT COUNT(*) as c FROM reports WHERE status='Bahaya'");
    const waspada = await db.query("SELECT COUNT(*) as c FROM reports WHERE status='Waspada'");
    const aman = await db.query("SELECT COUNT(*) as c FROM reports WHERE status='Aman'");
    const stats = { total: total[0].c, bahaya: bahaya[0].c, waspada: waspada[0].c, aman: aman[0].c };
    
    let usersList = [];
    if(user.role === 'admin') usersList = await db.query("SELECT username, role FROM users");
    
    // Notifikasi SweetAlert
    const notification = req.session.notification || null;
    req.session.notification = null;

    res.render('dashboard', { user, reports, stats, usersList, notification });
});

app.post('/lapor', requireLogin, upload.single('foto'), (req, res) => {
    const { desa, kec, hama, status, lat, lon } = req.body;
    const foto = req.file ? `/uploads/${req.file.filename}` : '';
    const waktu = new Date().toLocaleString('id-ID');
    
    db.run(`INSERT INTO reports (user_id, user_name, desa, kec, hama, status, lat, lon, foto, waktu) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.session.user.id, req.session.user.fullname, desa, kec, hama, status, lat, lon, foto, waktu],
            (err) => {
                if(!err) req.session.notification = { type: 'success', message: 'Laporan berhasil dikirim!' };
                res.redirect('/dashboard');
            });
});

// --- FITUR 2: SIPINTARSHOP (Pasar Tani) ---
app.get('/pasar', requireLogin, async (req, res) => {
    const user = req.session.user;
    const products = await db.query("SELECT * FROM products ORDER BY id DESC");
    res.render('pasar', { user, products });
});

app.post('/pasar/add', requireLogin, upload.single('product_photo'), (req, res) => {
    const { product_name, price, description, seller_phone } = req.body;
    const photo = req.file ? `/uploads/${req.file.filename}` : 'https://cdn-icons-png.flaticon.com/512/2921/2921822.png'; 
    const created_at = new Date().toLocaleString('id-ID');
    
    // Format nomor HP (08 -> 62)
    let phone = seller_phone.replace(/^0/, '62');

    db.run(`INSERT INTO products (user_id, seller_name, seller_phone, product_name, price, description, photo, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.session.user.id, req.session.user.fullname, phone, product_name, price, description, photo, created_at],
            (err) => res.redirect('/pasar'));
});

app.get('/pasar/delete/:id', requireLogin, async (req, res) => {
    const productId = req.params.id;
    const user = req.session.user;
    const product = await db.query("SELECT * FROM products WHERE id = ?", [productId]);
    
    if (product.length > 0 && (user.role === 'admin' || user.id === product[0].user_id)) {
        db.run("DELETE FROM products WHERE id = ?", [productId]);
    }
    res.redirect('/pasar');
});

// --- FITUR 3: PROFIL SAYA ---
app.get('/profil', requireLogin, (req, res) => {
    const user = req.session.user;
    db.get("SELECT * FROM users WHERE id = ?", [user.id], (err, row) => {
        req.session.user = row;
        const notification = req.session.notification || null;
        req.session.notification = null;
        res.render('profil', { user: row, notification });
    });
});

app.post('/profil/update', requireLogin, upload.single('profile_photo'), (req, res) => {
    const { fullname, bio, phone } = req.body;
    const userId = req.session.user.id;
    
    if (req.file) {
        const photo = `/uploads/${req.file.filename}`;
        db.run("UPDATE users SET fullname=?, bio=?, phone=?, photo=? WHERE id=?", 
            [fullname, bio, phone, photo, userId], (err) => {
                req.session.notification = { type: 'success', message: 'Profil berhasil diperbarui!' };
                res.redirect('/profil');
            });
    } else {
        db.run("UPDATE users SET fullname=?, bio=?, phone=? WHERE id=?", 
            [fullname, bio, phone, userId], (err) => {
                req.session.notification = { type: 'success', message: 'Profil berhasil diperbarui!' };
                res.redirect('/profil');
            });
    }
});

// --- FITUR 4: SI-PEDULI (Bantuan Dinas) - BARU! ---
app.get('/bantuan', requireLogin, async (req, res) => {
    const user = req.session.user;
    let proposals;

    // Admin melihat SEMUA proposal, User cuma melihat PUNYA SENDIRI
    if (user.role === 'admin') {
        proposals = await db.query("SELECT * FROM proposals ORDER BY id DESC");
    } else {
        proposals = await db.query("SELECT * FROM proposals WHERE user_id = ? ORDER BY id DESC", [user.id]);
    }

    const notification = req.session.notification || null;
    req.session.notification = null;
    res.render('bantuan', { user, proposals, notification });
});

app.post('/bantuan/add', requireLogin, (req, res) => {
    const { type, amount, reason } = req.body;
    const created_at = new Date().toLocaleString('id-ID');
    
    db.run(`INSERT INTO proposals (user_id, user_name, type, amount, reason, created_at) 
            VALUES (?, ?, ?, ?, ?, ?)`,
            [req.session.user.id, req.session.user.fullname, type, amount, reason, created_at],
            (err) => {
                req.session.notification = { type: 'success', message: 'Proposal berhasil diajukan!' };
                res.redirect('/bantuan');
            });
});

// Admin Actions untuk Bantuan
app.get('/admin/bantuan/approve/:id', requireAdmin, (req, res) => {
    db.run("UPDATE proposals SET status = 'Disetujui' WHERE id = ?", [req.params.id], () => {
        req.session.notification = { type: 'success', message: 'Proposal Disetujui' };
        res.redirect('/bantuan');
    });
});

app.get('/admin/bantuan/reject/:id', requireAdmin, (req, res) => {
    db.run("UPDATE proposals SET status = 'Ditolak' WHERE id = ?", [req.params.id], () => {
        req.session.notification = { type: 'error', message: 'Proposal Ditolak' };
        res.redirect('/bantuan');
    });
});

// --- ADMIN & API ROUTES (Lainnya) ---
app.get('/admin/verify/:id', requireAdmin, (req, res) => { db.run("UPDATE reports SET is_verified = 1 WHERE id = ?", [req.params.id], () => res.redirect('/dashboard')); });
app.get('/admin/reject/:id', requireAdmin, (req, res) => { db.run("DELETE FROM reports WHERE id = ?", [req.params.id], () => res.redirect('/dashboard')); });
app.get('/admin/delete-report/:id', requireAdmin, (req, res) => { db.run("DELETE FROM reports WHERE id = ?", [req.params.id], () => res.redirect('/dashboard')); });
app.post('/admin/create-user', requireAdmin, (req, res) => {
    const { newFullname, newUsername, newPassword, newRole } = req.body;
    const hash = bcrypt.hashSync(newPassword, 10);
    db.run("INSERT INTO users (fullname, username, password, role) VALUES (?,?,?,?)", [newFullname, newUsername, hash, newRole], (err) => res.redirect('/dashboard'));
});
app.post('/admin/reset-password', requireAdmin, (req, res) => {
    const { targetUsername, newPass } = req.body;
    const hash = bcrypt.hashSync(newPass, 10);
    db.run("UPDATE users SET password = ? WHERE username = ?", [hash, targetUsername], (err) => res.redirect('/dashboard'));
});
app.get('/admin/export-csv', requireAdmin, async (req, res) => {
    const reports = await db.query("SELECT * FROM reports");
    let csv = "ID,Waktu,Pelapor,Desa,Kecamatan,Hama,Status,Lat,Lon\n";
    reports.forEach(r => csv += `${r.id},"${r.waktu}","${r.user_name}","${r.desa}","${r.kec}","${r.hama}","${r.status}",${r.lat},${r.lon}\n`);
    res.header('Content-Type', 'text/csv'); res.attachment('data-laporan.csv'); res.send(csv);
});
app.get('/api/heatmap-data', async (req, res) => {
    try {
        const reports = await db.query("SELECT lat, lon, status FROM reports WHERE is_verified = 1");
        const heatmapData = reports.map(r => {
            let intensity = 0.2; if (r.status === 'Bahaya') intensity = 1.0; else if (r.status === 'Waspada') intensity = 0.6;
            return [r.lat, r.lon, intensity];
        });
        res.json(heatmapData);
    } catch (err) { res.status(500).json({ error: "Gagal ambil data" }); }
});

app.listen(PORT, () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));