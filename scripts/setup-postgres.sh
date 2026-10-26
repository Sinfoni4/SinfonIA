#!/bin/bash

echo "🔐 This script may require sudo privileges."

echo "📦 Updating packages..."
sudo apt update

echo "📦 Installing PostgreSQL..."
sudo apt install -y postgresql postgresql-contrib

echo "▶️ Starting PostgreSQL..."
sudo systemctl start postgresql

echo "✅ PostgreSQL installed and started."

echo "👤 Creating user and database..."

sudo -u postgres psql <<EOF
DO \$\$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles WHERE rolname = 'sinfonia_user'
   ) THEN
      CREATE ROLE sinfonia_user LOGIN PASSWORD 'sinfonia_pass';
   END IF;
END
\$\$;

DO \$\$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_database WHERE datname = 'sinfonia_db'
   ) THEN
      CREATE DATABASE sinfonia_db OWNER sinfonia_user;
   END IF;
END
\$\$;
EOF

echo "🎉 Setup complete."

