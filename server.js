const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = 'database.json';

// Tự động tạo file dữ liệu nếu chưa có
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, progress: {} }));
}

// Xử lý Đăng ký / Đăng nhập
app.post('/api/auth', (req, res) => {
    const { username, password, type } = req.body;
    const db = JSON.parse(fs.readFileSync(DB_FILE));

    if (type === 'register') {
        if (db.users[username]) return res.status(400).json({ error: "Tài khoản này đã tồn tại!" });
        db.users[username] = password;
        db.progress[username] = { loginHistory: [] };
        fs.writeFileSync(DB_FILE, JSON.stringify(db));
        return res.json({ message: "Đăng ký thành công!", progress: db.progress[username] });
    } else if (type === 'login') {
        if (db.users[username] === password) {
            return res.json({ message: "Đăng nhập thành công!", progress: db.progress[username] || {} });
        }
        return res.status(400).json({ error: "Sai tài khoản hoặc mật khẩu!" });
    }
});

// Xử lý lưu tiến độ
app.post('/api/progress', (req, res) => {
    const { username, progress } = req.body;
    const db = JSON.parse(fs.readFileSync(DB_FILE));
    
    if(db.users[username]) {
        db.progress[username] = progress;
        fs.writeFileSync(DB_FILE, JSON.stringify(db));
        res.json({ success: true });
    } else {
        res.status(401).json({ error: "Tài khoản không hợp lệ!" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server đang chạy tại cổng ${PORT}`);
});