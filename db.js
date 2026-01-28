const mysql = require("mysql2");

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "Gopal@123",
    database: "insta_clone"
});

db.connect((err) => {
    if (err) {
        console.log("MySQL Connection Error:", err);
    } else {
        console.log("MySQL Connected Successfully!");
    }
});

module.exports = db;