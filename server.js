const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const redis = require('redis');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. CẤU HÌNH POSTGRESQL (LƯU TRỮ VĨNH VIỄN)
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                username VARCHAR(255) PRIMARY KEY,
                password VARCHAR(255) NOT NULL
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS progress (
                username VARCHAR(255) PRIMARY KEY REFERENCES users(username),
                progress_data JSONB
            );
        `);
        console.log("✅ PostgreSQL: Sẵn sàng!");
    } catch (err) {
        console.error("❌ Lỗi PostgreSQL:", err);
    }
}
initDB();

// ==========================================
// 2. CẤU HÌNH REDIS (BỘ NHỚ ĐỆM TỐC ĐỘ CAO)
// ==========================================
const redisClient = redis.createClient({
    url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.log('❌ Lỗi Redis:', err));
redisClient.on('connect', () => console.log('⚡ Redis: Sẵn sàng!'));

async function initRedis() {
    try {
        await redisClient.connect();
    } catch (err) {
        console.error("❌ Không thể kết nối Redis lúc khởi động");
    }
}
initRedis();

// ==========================================
// 3. CÁC API XỬ LÝ DỮ LIỆU
// ==========================================

// API Đăng ký & Đăng nhập
app.post('/api/auth', async (req, res) => {
    const { username, password, type } = req.body;
    const cacheKey = `user_progress_${username}`;
    
    try {
        if (type === 'register') {
            const userCheck = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
            if (userCheck.rows.length > 0) return res.status(400).json({ error: "Tài khoản này đã tồn tại!" });
            
            await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
            await pool.query('INSERT INTO progress (username, progress_data) VALUES ($1, $2)', [username, JSON.stringify({})]);
            
            await redisClient.setEx(cacheKey, 3600, JSON.stringify({}));
            return res.json({ message: "Đăng ký thành công!", progress: {} });
            
        } else if (type === 'login') {
            const userQuery = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
            
            if (userQuery.rows.length > 0 && userQuery.rows[0].password === password) {
                const cachedProgress = await redisClient.get(cacheKey);
                if (cachedProgress) {
                    return res.json({ message: "Đăng nhập thành công!", progress: JSON.parse(cachedProgress) });
                }

                const progQuery = await pool.query('SELECT progress_data FROM progress WHERE username = $1', [username]);
                const progress = progQuery.rows.length > 0 ? progQuery.rows[0].progress_data : {};
                
                await redisClient.setEx(cacheKey, 3600, JSON.stringify(progress));
                return res.json({ message: "Đăng nhập thành công!", progress: progress });
            }
            return res.status(400).json({ error: "Sai tài khoản hoặc mật khẩu!" });
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Lỗi máy chủ cơ sở dữ liệu!" });
    }
});

// API Đặt lại mật khẩu (Quên mật khẩu)
app.post('/api/reset-password', async (req, res) => {
    const { username, newPassword } = req.body;
    try {
        const userCheck = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: "Tài khoản không tồn tại!" });
        }
        await pool.query('UPDATE users SET password = $1 WHERE username = $2', [newPassword, username]);
        res.json({ message: "Khôi phục thành công! Hãy đăng nhập lại." });
    } catch (error) {
        res.status(500).json({ error: "Lỗi máy chủ!" });
    }
});

// API Xóa tài khoản vĩnh viễn
app.delete('/api/account', async (req, res) => {
    const { username } = req.body;
    try {
        // 1. Xóa trong PostgreSQL (Xóa bảng progress trước để tránh lỗi khóa ngoại)
        await pool.query('DELETE FROM progress WHERE username = $1', [username]);
        await pool.query('DELETE FROM users WHERE username = $1', [username]);
        
        // 2. Xóa Cache trong Redis
        const cacheKey = `user_progress_${username}`;
        await redisClient.del(cacheKey);
        
        res.json({ success: true, message: "Tài khoản đã được xóa vĩnh viễn!" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Lỗi khi xóa tài khoản!" });
    }
});

// API Lưu Tiến độ học tập
app.post('/api/progress', async (req, res) => {
    const { username, progress } = req.body;
    const cacheKey = `user_progress_${username}`;
    
    try {
        await pool.query(`
            INSERT INTO progress (username, progress_data) 
            VALUES ($1, $2) 
            ON CONFLICT (username) 
            DO UPDATE SET progress_data = EXCLUDED.progress_data;
        `, [username, JSON.stringify(progress)]);
        
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(progress));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Lỗi khi lưu tiến độ!" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Máy chủ đang chạy tại port ${PORT}`);
});