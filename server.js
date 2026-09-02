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