const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const redis = require('redis');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CẤU HÌNH POSTGRESQL 
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (username VARCHAR(255) PRIMARY KEY, password VARCHAR(255) NOT NULL);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS progress (username VARCHAR(255) PRIMARY KEY REFERENCES users(username), progress_data JSONB);`);
        console.log("✅ PostgreSQL: Sẵn sàng!");
    } catch (err) { console.error("❌ Lỗi PostgreSQL:", err); }
}
initDB();

// CẤU HÌNH REDIS 
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', (err) => console.log('❌ Lỗi Redis:', err));
redisClient.on('connect', () => console.log('⚡ Redis: Sẵn sàng!'));
async function initRedis() { try { await redisClient.connect(); } catch (err) { console.error("❌ Lỗi kết nối Redis"); } }
initRedis();

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
                if (cachedProgress) return res.json({ message: "Đăng nhập thành công!", progress: JSON.parse(cachedProgress) });

                const progQuery = await pool.query('SELECT progress_data FROM progress WHERE username = $1', [username]);
                const progress = progQuery.rows.length > 0 ? progQuery.rows[0].progress_data : {};
                await redisClient.setEx(cacheKey, 3600, JSON.stringify(progress));
                return res.json({ message: "Đăng nhập thành công!", progress: progress });
            }
            return res.status(400).json({ error: "Sai tài khoản hoặc mật khẩu!" });
        }
    } catch (error) { return res.status(500).json({ error: "Lỗi máy chủ!" }); }
});

// API LẤY TIẾN ĐỘ (Phục vụ đồng bộ khi F5 hoặc mở web trên máy khác)
app.post('/api/get-progress', async (req, res) => {
    const { username } = req.body;
    const cacheKey = `user_progress_${username}`;
    try {
        const cachedProgress = await redisClient.get(cacheKey);
        if (cachedProgress) return res.json({ progress: JSON.parse(cachedProgress) });

        const progQuery = await pool.query('SELECT progress_data FROM progress WHERE username = $1', [username]);
        const progress = progQuery.rows.length > 0 ? progQuery.rows[0].progress_data : {};
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(progress));
        return res.json({ progress: progress });
    } catch (error) { return res.status(500).json({ error: "Lỗi máy chủ!" }); }
});

// API Lưu Tiến độ
app.post('/api/progress', async (req, res) => {
    const { username, progress } = req.body;
    const cacheKey = `user_progress_${username}`;
    try {
        await pool.query(`INSERT INTO progress (username, progress_data) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET progress_data = EXCLUDED.progress_data;`, [username, JSON.stringify(progress)]);
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(progress));
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Lỗi khi lưu tiến độ!" }); }
});

// API Đặt lại mật khẩu & Xóa tài khoản
app.post('/api/reset-password', async (req, res) => {
    const { username, newPassword } = req.body;
    try {
        const userCheck = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
        if (userCheck.rows.length === 0) return res.status(404).json({ error: "Tài khoản không tồn tại!" });
        await pool.query('UPDATE users SET password = $1 WHERE username = $2', [newPassword, username]);
        res.json({ message: "Khôi phục thành công! Hãy đăng nhập lại." });
    } catch (error) { res.status(500).json({ error: "Lỗi máy chủ!" }); }
});

app.delete('/api/account', async (req, res) => {
    const { username } = req.body;
    try {
        await pool.query('DELETE FROM progress WHERE username = $1', [username]);
        await pool.query('DELETE FROM users WHERE username = $1', [username]);
        await redisClient.del(`user_progress_${username}`);
        res.json({ success: true, message: "Đã xóa vĩnh viễn!" });
    } catch (error) { res.status(500).json({ error: "Lỗi xóa tài khoản!" }); }
});

app.listen(process.env.PORT || 3000, () => console.log(`✅ Server đang chạy`));