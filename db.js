const mysql = require("mysql2");

const db = mysql.createConnection(
  "mysql://root:XmlERkFwZadGhLhMJnjVnzZLwzjkHlQy@metro.proxy.rlwy.net:22246/railway"
);

db.connect((err) => {
  if (err) {
    console.error("❌ MySQL connection failed:", err.message);
  } else {
    console.log("✅ MySQL connected successfully");
  }
});

module.exports = db;





