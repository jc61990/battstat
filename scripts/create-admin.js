#!/usr/bin/env node
'use strict';

const readline = require('readline');
const path = require('path');

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'battstat.db');

const db = require('../db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

async function main() {
  console.log('\n=== BattStat — Create Admin User ===\n');

  const existingUsers = db.getUsers();
  if (existingUsers.length > 0) {
    console.log('Existing users:');
    existingUsers.forEach(u => console.log(`  ${u.username} (${u.role_name})`));
    console.log('');
  }

  const username = (await ask('Username [admin]: ')).trim() || 'admin';
  const password = (await ask('Password: ')).trim();

  if (!password || password.length < 8) {
    console.error('Error: Password must be at least 8 characters');
    process.exit(1);
  }

  const displayName = (await ask(`Display name [${username}]: `)).trim() || username;
  const email       = (await ask('Email (optional): ')).trim();

  rl.close();

  const roles = db.getRoles();
  const adminRole = roles.find(r => r.name === 'Administrator');
  if (!adminRole) {
    console.error('Error: Administrator role not found. Run the server once first to bootstrap roles.');
    process.exit(1);
  }

  try {
    const user = db.createUser({
      username,
      password,
      display_name: displayName,
      email,
      role_id:      adminRole.id,
      session_type: 'persistent',
      session_ttl_h: 8,
    });
    console.log(`\nAdmin user created successfully:`);
    console.log(`  Username:  ${user.username}`);
    console.log(`  Role:      Administrator`);
    console.log(`\nYou can now log in at http://<server>:3000/login\n`);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      console.error(`Error: Username "${username}" already exists. Use a different username or edit the existing user.`);
    } else {
      console.error('Error:', e.message);
    }
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
