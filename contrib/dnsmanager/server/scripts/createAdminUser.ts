import bcrypt from "bcrypt";
import mysql from "mysql2/promise";
import { loadDatabaseConfig } from "../src/config.js";

async function createAdminUser() {
  const dbConfig = loadDatabaseConfig();

  const connection = await mysql.createConnection({
    host: dbConfig.hosts[0].host,
    port: dbConfig.hosts[0].port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  });

  console.log("Connected to database");

  // Generate hash for 'admin123'
  const passwordHash = await bcrypt.hash("admin123", 10);

  // Check if admin user already exists
  const [existing] = await connection.query(
    "SELECT id FROM dnsmanager_users WHERE username = 'admin'",
    []
  );

  if ((existing as any[]).length > 0) {
    console.log("Admin user already exists, updating password...");
    await connection.execute(
      "UPDATE dnsmanager_users SET password_hash = ?, active = 1 WHERE username = 'admin'",
      [passwordHash]
    );
    console.log("Admin password updated to: admin123");
  } else {
    console.log("Creating admin user...");
    await connection.execute(
      `INSERT INTO dnsmanager_users
       (username, email, password_hash, full_name, role, active, require_2fa, twofa_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["admin", "admin@localhost", passwordHash, "System Administrator", "superadmin", 1, 0, "none"]
    );
    console.log("Admin user created successfully!");
  }

  console.log("\nLogin credentials:");
  console.log("Username: admin");
  console.log("Password: admin123");
  console.log("\n⚠️  Please change this password immediately after first login!");

  await connection.end();
}

createAdminUser().catch((error) => {
  console.error("Error creating admin user:", error);
  process.exit(1);
});
