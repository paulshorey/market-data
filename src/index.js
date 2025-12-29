const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

/**
 * Database Connection
 * 
 * Uses private networking when deployed on Railway (postgres.railway.internal)
 * Falls back to public URL for local development
 * 
 * The DATABASE_URL environment variable should be set:
 * - Railway: Reference variable ${{Postgres.DATABASE_URL}} or use private URL
 * - Local: Public proxy URL from Railway dashboard
 */
const getDatabaseUrl = () => {
  // If DATABASE_URL is explicitly set, use it
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  
  // Check if running on Railway (private networking available)
  if (process.env.RAILWAY_ENVIRONMENT_NAME) {
    // Use private networking URL
    return 'postgresql://postgres:yDUUkjtpVjZfrQQyogskEhFmEKiIhSLr@postgres.railway.internal:5432/railway';
  }
  
  // Local development - use public proxy URL
  return 'postgresql://postgres:yDUUkjtpVjZfrQQyogskEhFmEKiIhSLr@shinkansen.proxy.rlwy.net:43439/railway';
};

const pool = new Pool({
  connectionString: getDatabaseUrl(),
  // Connection pool settings
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Log which database URL is being used (without password)
const dbUrl = getDatabaseUrl();
const safeDbUrl = dbUrl.replace(/:[^:@]+@/, ':***@');
console.log(`Database URL: ${safeDbUrl}`);

/**
 * Health Check Endpoint
 * 
 * Railway uses this to verify the service is healthy before routing traffic.
 * Returns 200 when the service is ready.
 */
app.get('/health', async (req, res) => {
  try {
    // Verify database connection is working
    await pool.query('SELECT 1');
    res.status(200).json({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(503).json({ 
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

/**
 * Root API Endpoint
 * 
 * Returns the database schema information:
 * - List of all tables
 * - Columns for each table with their data types
 */
app.get('/', async (req, res) => {
  try {
    // Get all tables in the public schema
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const tables = tablesResult.rows.map(row => row.table_name);

    // Get columns for each table
    const schema = {};
    for (const tableName of tables) {
      const columnsResult = await pool.query(`
        SELECT 
          column_name,
          data_type,
          is_nullable,
          column_default,
          character_maximum_length
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      schema[tableName] = columnsResult.rows.map(col => ({
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === 'YES',
        default: col.column_default,
        maxLength: col.character_maximum_length
      }));
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || 'local',
      database: {
        tableCount: tables.length,
        tables: schema
      }
    });

  } catch (error) {
    console.error('Error fetching schema:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch database schema',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Start Server
 * 
 * Listen on "::" to support both IPv4 and IPv6.
 * This is required for Railway's private networking to work correctly.
 */
app.listen(port, '::', () => {
  console.log(`🚀 Market Data API server running on port ${port}`);
  console.log(`   Environment: ${process.env.RAILWAY_ENVIRONMENT_NAME || 'local'}`);
  console.log(`   Health check: http://localhost:${port}/health`);
  console.log(`   Schema API: http://localhost:${port}/`);
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await pool.end();
  process.exit(0);
});
