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

// API Đăng ký & Đăng nhập (Tích hợp Redis Cache)
app.post('/api/auth', async (req, res) => {
    const { username, password, type } = req.body;
    const cacheKey = `user_progress_${username}`; // Tạo chìa khóa tìm trong Redis
    
    try {
        if (type === 'register') {
            const userCheck = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
            if (userCheck.rows.length > 0) return res.status(400).json({ error: "Tài khoản này đã tồn tại!" });
            
            // Lưu vào PostgreSQL
            await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
            await pool.query('INSERT INTO progress (username, progress_data) VALUES ($1, $2)', [username, JSON.stringify({})]);
            
            // Lưu ngay một bản sao trống vào Redis để lần sau load siêu tốc
            await redisClient.setEx(cacheKey, 3600, JSON.stringify({}));
            
            return res.json({ message: "Đăng ký thành công!", progress: {} });
            
        } else if (type === 'login') {
            const userQuery = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
            
            if (userQuery.rows.length > 0 && userQuery.rows[0].password === password) {
                
                // THUẬT TOÁN CACHE: Tìm tiến độ học trong Redis trước
                const cachedProgress = await redisClient.get(cacheKey);
                if (cachedProgress) {
                    console.log(`⚡ Lấy tiến độ của ${username} từ REDIS (Siêu nhanh)`);
                    return res.json({ message: "Đăng nhập thành công!", progress: JSON.parse(cachedProgress) });
                }

                // Nếu Redis không có (hết hạn cache), lặn xuống PostgreSQL tìm
                console.log(`🐢 Lấy tiến độ của ${username} từ POSTGRESQL (Tải lần đầu)`);
                const progQuery = await pool.query('SELECT progress_data FROM progress WHERE username = $1', [username]);
                const progress = progQuery.rows.length > 0 ? progQuery.rows[0].progress_data : {};
                
                // Trả cho người dùng xong thì chép một bản lên Redis để lưu 1 tiếng (3600 giây)
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

// API Lưu Tiến độ học tập (Cập nhật cả PostgreSQL và Redis)
app.post('/api/progress', async (req, res) => {
    const { username, progress } = req.body;
    const cacheKey = `user_progress_${username}`;
    
    try {
        // 1. Lưu vĩnh viễn vào PostgreSQL
        await pool.query(`
            INSERT INTO progress (username, progress_data) 
            VALUES ($1, $2) 
            ON CONFLICT (username) 
            DO UPDATE SET progress_data = EXCLUDED.progress_data;
        `, [username, JSON.stringify(progress)]);
        
        // 2. Cập nhật ngay bản sao trong Redis để không bị chênh lệch dữ liệu (Cache Invalidation)
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(progress));
        
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Lỗi khi lưu tiến độ!" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Máy chủ đang chạy tại port ${PORT}`);
});