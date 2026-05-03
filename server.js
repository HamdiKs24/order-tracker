import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// Create log file to see what's happening
function logMessage(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    console.log(logLine);
    try {
        fs.appendFileSync('webhook-logs.txt', logLine);
    } catch(e) { /* ignore if can't write */ }
}

logMessage('🚀 Server starting up...');

// Dynamic import for better-sqlite3 (handles compatibility better)
let db;
async function initDatabase() {
    try {
        const Database = (await import('better-sqlite3')).default;
        db = new Database('orders.db');
        
        // Create table
        db.exec(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_code TEXT UNIQUE,
                customer_name TEXT,
                phone TEXT,
                amount REAL,
                status TEXT,
                order_date TEXT,
                delivery_date TEXT,
                raw_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        logMessage('✅ Database ready');
        return true;
    } catch (error) {
        logMessage('❌ Database error: ' + error.message);
        return false;
    }
}

// WEBHOOK ENDPOINT - Your store sends data here
app.post('/webhook/order-update', (req, res) => {
    if (!db) {
        logMessage('⚠️ Database not ready, order not saved');
        return res.status(500).json({ error: 'Database not ready' });
    }
    
    const order = req.body;
    logMessage('📦 Webhook received! Data: ' + JSON.stringify(order));
    
    // Try different ways to get order code
    let orderCode = order.id || order.order_number || order.code || order.orderId;
    if (!orderCode) orderCode = 'UNKNOWN-' + Date.now();
    
    // Try different ways to get amount
    let amount = 0;
    if (order.total) amount = parseFloat(order.total);
    if (order.total_price) amount = parseFloat(order.total_price);
    if (order.amount) amount = parseFloat(order.amount);
    
    // Try different ways to get status
    let status = (order.status || order.state || '').toLowerCase();
    
    // Check if delivered
    const isDelivered = status.includes('delivered') || 
                        status.includes('paid') || 
                        status === 'completed';
    
    // Get customer name
    let customerName = 'Unknown';
    if (order.customer?.name) customerName = order.customer.name;
    if (order.shipping?.name) customerName = order.shipping.name;
    if (order.name) customerName = order.name;
    
    // Get phone
    let phone = 'Unknown';
    if (order.customer?.phone) phone = order.customer.phone;
    if (order.phone) phone = order.phone;
    
    logMessage(`📊 Order: ${orderCode}, Amount: ${amount}, Status: ${status}, Delivered: ${isDelivered}`);
    
    if (isDelivered && amount > 0) {
        try {
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO orders 
                (order_code, customer_name, phone, amount, status, order_date, delivery_date, raw_data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            stmt.run(
                orderCode, 
                customerName, 
                phone, 
                amount, 
                status, 
                new Date().toISOString(),
                new Date().toISOString(),
                JSON.stringify(order)
            );
            
            logMessage(`✅ RECORDED: ${orderCode} - ${amount} TND`);
            res.status(200).json({ success: true, message: 'Order recorded' });
        } catch (err) {
            logMessage(`❌ Database error: ${err.message}`);
            res.status(500).json({ error: 'Database error' });
        }
    } else {
        logMessage(`⏭️ Skipped (not delivered): ${orderCode}`);
        res.status(200).json({ success: true, message: 'Received but not delivered' });
    }
});

// API - Get daily breakdown
app.get('/api/daily-breakdown', (req, res) => {
    if (!db) {
        return res.json([]);
    }
    
    try {
        const rows = db.prepare(`
            SELECT 
                DATE(delivery_date) as date,
                COUNT(*) as order_count,
                SUM(amount) as total,
                GROUP_CONCAT(amount) as amounts
            FROM orders 
            WHERE status LIKE '%delivered%' OR status LIKE '%paid%' OR status = 'completed'
            GROUP BY DATE(delivery_date)
            ORDER BY date DESC
        `).all();
        
        const result = rows.map(row => {
            const amountList = row.amounts.split(',').map(Number);
            const breakdown = {};
            amountList.forEach(amt => {
                breakdown[amt] = (breakdown[amt] || 0) + 1;
            });
            
            return {
                date: row.date,
                total: row.total,
                count: row.order_count,
                breakdown: breakdown,
                formula: Object.entries(breakdown)
                    .map(([amt, qty]) => `${qty}x${amt}TND`)
                    .join(' + ')
            };
        });
        
        res.json(result);
    } catch (err) {
        logMessage(`❌ Daily breakdown error: ${err.message}`);
        res.json([]);
    }
});

// API - Get all orders
app.get('/api/orders', (req, res) => {
    if (!db) {
        return res.json([]);
    }
    
    try {
        const orders = db.prepare(`
            SELECT order_code, customer_name, phone, amount, delivery_date
            FROM orders 
            WHERE status LIKE '%delivered%' OR status LIKE '%paid%' OR status = 'completed'
            ORDER BY delivery_date DESC
            LIMIT 100
        `).all();
        
        res.json(orders);
    } catch (err) {
        logMessage(`❌ Orders fetch error: ${err.message}`);
        res.json([]);
    }
});

// Serve the dashboard
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'dashboard.html'));
});

// Start server after database is ready
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        logMessage(`🚀 Server running on port ${PORT}`);
        console.log(`\n✅ Your tracker is LIVE!`);
        console.log(`📊 Dashboard: https://your-app.onrender.com`);
        console.log(`🔗 Webhook URL: https://your-app.onrender.com/webhook/order-update\n`);
    });
}).catch(err => {
    logMessage(`❌ Failed to start: ${err.message}`);
    process.exit(1);
});
