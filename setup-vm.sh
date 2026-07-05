#!/bin/bash
# מריץ על ה-VM אחרי ה-SSH הראשון

set -e

# התקן Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# התקן git
sudo apt-get install -y git

# Clone הפרויקט
git clone https://github.com/<YOUR_GITHUB_USERNAME>/VOLLEYAI.git
cd VOLLEYAI

# צור קובץ .env
cat > .env << 'EOF'
MONGO_URI=mongodb+srv://yahavatias13_db_user:AiE6geJYDqW8QLYo@cluster0.zr4ir73.mongodb.net/volleyai?appName=Cluster0
JWT_SECRET=volleyai_super_secret_jwt_key_2024
APP_URL=http://<VM_EXTERNAL_IP>
CORS_ORIGINS=http://<VM_EXTERNAL_IP>
VITE_GOOGLE_CLIENT_ID=452166375700-i4t3p07k4phoosbqg1o4488ibdkuhra5.apps.googleusercontent.com
EOF

echo "עדכן את ה-.env עם ה-IP האמיתי של ה-VM, ואז הרץ:"
echo "docker compose -f docker-compose.prod.yml up -d --build"
