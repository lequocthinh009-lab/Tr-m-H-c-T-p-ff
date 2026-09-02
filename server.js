const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cấu hình kết nối PostgreSQL (Render sẽ tự cung cấp biến DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Cho phép kết nối SSL bảo mật trên Render
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Tự động tạo Bảng dữ liệu nếu chưa có
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
        console.log("✅ Đã kết nối và thiết lập xong Database PostgreSQL!");
    } catch (err) {
        console.error("❌ Lỗi khởi tạo DB:", err);
    }
}
initDB();

// API Đăng ký & Đăng nhập
app.post('/api/auth', async (req, res) => {
    const { username, password, type } = req.body;
    
    try {
        if (type === 'register') {
            // Kiểm tra xem user đã tồn tại chưa
            const userCheck = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
            if (userCheck.rows.length > 0) {
                return res.status(400).json({ error: "Tài khoản này đã tồn tại!" });
            }
            
            // Lưu user mới và tạo dữ liệu tiến độ rỗng
            await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
            await pool.query('INSERT INTO progress (username, progress_data) VALUES ($1, $2)', [username, JSON.stringify({})]);
            
            return res.json({ message: "Đăng ký thành công!", progress: {} });
            
        } else if (type === 'login') {
            // Lấy thông tin user
            const userQuery = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
            
            if (userQuery.rows.length > 0 && userQuery.rows[0].password === password) {
                // Lấy tiến độ học tập
                const progQuery = await pool.query('SELECT progress_data FROM progress WHERE username = $1', [username]);
                const progress = progQuery.rows.length > 0 ? progQuery.rows[0].progress_data : {};
                
                return res.json({ message: "Đăng nhập thành công!", progress: progress });
            }
            return res.status(400).json({ error: "Sai tài khoản hoặc mật khẩu!" });
        }
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Lỗi máy chủ cơ sở dữ liệu!" });
    }
});

// API Lưu Tiến độ học tập
app.post('/api/progress', async (req, res) => {
    const { username, progress } = req.body;
    
    try {
        // Cập nhật tiến độ (Upsert: Nếu chưa có thì thêm, có rồi thì ghi đè)
        await pool.query(`
            INSERT INTO progress (username, progress_data) 
            VALUES ($1, $2) 
            ON CONFLICT (username) 
            DO UPDATE SET progress_data = EXCLUDED.progress_data;
        `, [username, JSON.stringify(progress)]);
        
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Lỗi khi lưu tiến độ!" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server đang chạy tại port ${PORT}`);
});
const redis = require('redis');

// Khởi tạo kết nối Redis (Render tự cấp URL qua biến môi trường)
const redisClient = redis.createClient({
    url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.log('❌ Lỗi kết nối Redis:', err));
redisClient.on('connect', () => console.log('✅ Đã kết nối Redis thành công!'));

// Hàm khởi động Redis
async function initRedis() {
    await redisClient.connect();
}
initRedis();
// Ghi dữ liệu vào Redis (Ví dụ: Lưu trạng thái đăng nhập 1 tiếng)
await redisClient.setEx('session_user123', 3600, 'logged_in');

// Đọc dữ liệu từ Redis
const sessionStatus = await redisClient.get('session_user123');
// API Lấy danh sách từ vựng theo Cấp độ (Ví dụ: HSK_1, TOEIC_500)
app.get('/api/vocab/:course/:level', async (req, res) => {
    const { course, level } = req.params;
    
    // Tạo chìa khóa (Key) duy nhất cho mỗi bài học để lưu vào Redis
    const cacheKey = `vocab_cache_${course}_${level}`;

    try {
        // BƯỚC 1: Tìm trong Redis trước
        const cachedData = await redisClient.get(cacheKey);
        
        if (cachedData) {
            console.log(`⚡ Lấy từ vựng ${course} ${level} từ Redis Cache (Siêu tốc)`);
            // Dữ liệu trong Redis lưu dưới dạng chuỗi (String), cần parse lại thành JSON
            return res.json({ source: 'redis', data: JSON.parse(cachedData) });
        }

        // BƯỚC 2: Nếu Redis không có (hoặc đã hết hạn), tìm trong PostgreSQL
        console.log(`🐢 Lấy từ vựng ${course} ${level} từ PostgreSQL (Lần tải đầu tiên)`);
        
        // Giả sử bạn có bảng 'vocabulary' trong PostgreSQL
        const dbQuery = await pool.query(
            'SELECT word, pinyin, meaning, ex_cn, ex_vn FROM vocabulary WHERE course = $1 AND level = $2',
            [course, level]
        );
        const vocabData = dbQuery.rows;

        if (vocabData.length > 0) {
            // BƯỚC 3: Lưu bản sao vào Redis để dùng cho các lần sau
            // Lệnh setEx(key, số_giây_tồn_tại, giá_trị). Ở đây lưu 1 tiếng (3600 giây).
            await redisClient.setEx(cacheKey, 3600, JSON.stringify(vocabData));
            
            return res.json({ source: 'postgresql', data: vocabData });
        } else {
            return res.status(404).json({ error: "Chưa có dữ liệu từ vựng cho cấp độ này!" });
        }

    } catch (error) {
        console.error("Lỗi khi lấy từ vựng:", error);
        res.status(500).json({ error: "Lỗi máy chủ!" });
    }
});
// API Thêm từ vựng mới (Dành cho Admin)
app.post('/api/vocab/add', async (req, res) => {
    const { course, level, word, pinyin, meaning } = req.body;

    try {
        // 1. Lưu từ mới vào PostgreSQL
        await pool.query(
            'INSERT INTO vocabulary (course, level, word, pinyin, meaning) VALUES ($1, $2, $3, $4, $5)',
            [course, level, word, pinyin, meaning]
        );

        // 2. XÓA CACHE CŨ TRONG REDIS
        const cacheKey = `vocab_cache_${course}_${level}`;
        await redisClient.del(cacheKey); 
        console.log(`🗑️ Đã xóa cache cũ của ${course} ${level}`);

        res.json({ success: true, message: "Đã thêm từ vựng và làm mới Cache!" });
    } catch (error) {
        res.status(500).json({ error: "Lỗi thêm từ vựng" });
    }
});
