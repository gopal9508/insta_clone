const dotenv = require("dotenv");
dotenv.config();

const mysql = require("mysql2");

if (!process.env.MYSQLHOST) {
  console.error("❌ MYSQLHOST not found in env!");
  process.exit(1);
}

// Railway + Local Safe Connection
const db = mysql.createConnection({
  host: process.env.MYSQLHOST || "localhost",
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "",
  database: process.env.MYSQLDATABASE || "railway",
  port: process.env.MYSQLPORT || 3306,

  ssl: process.env.MYSQLHOST
    ? { rejectUnauthorized: false }
    : false,
});

db.connect((err) => {
  if (err) {
    console.error("❌ MySQL connection failed:", err.message);
  } else {
    console.log("✅ MySQL connected successfully");
  }
});

module.exports = db;

