/**
 * Real-time Performance Dashboard Server
 * WebSocket-based dashboard for monitoring system performance and alerts
 */

import { EventEmitter } from 'events';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { EnhancedLogger } from '../core/enhanced-logger.js';
import { PerformanceMonitor, type DashboardData } from './performance-monitor.js';
import { AlertManager } from './alert-manager.js';

export interface DashboardClient {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;
  connectedAt: Date;
  lastSeen: Date;
  metadata: {
    userAgent?: string;
    ip?: string;
    userId?: string;
    permissions?: string[];
  };
}

export interface DashboardMessage {
  type: 'subscribe' | 'unsubscribe' | 'request' | 'acknowledge' | 'command';
  id?: string;
  data?: any;
  timestamp: Date;
}

export interface DashboardResponse {
  type: 'data' | 'error' | 'ack' | 'notification';
  id?: string;
  data?: any;
  error?: string;
  timestamp: Date;
}

export interface DashboardConfig {
  port: number;
  host: string;
  updateInterval: number;
  maxClients: number;
  enableCompression: boolean;
  corsOrigins: string[];
  authRequired: boolean;
  apiKeys?: string[];
}

/**
 * Real-time dashboard server with WebSocket communication
 */
export class DashboardServer extends EventEmitter {
  private logger: EnhancedLogger;
  private performanceMonitor: PerformanceMonitor;
  private alertManager: AlertManager;
  private config: DashboardConfig;
  private server?: http.Server;
  private wss?: WebSocketServer;
  private clients = new Map<string, DashboardClient>();
  private updateTimer?: NodeJS.Timeout;
  private isRunning = false;

  constructor(
    logger: EnhancedLogger,
    performanceMonitor: PerformanceMonitor,
    alertManager: AlertManager,
    config: Partial<DashboardConfig> = {}
  ) {
    super();
    
    this.logger = logger;
    this.performanceMonitor = performanceMonitor;
    this.alertManager = alertManager;
    
    this.config = {
      port: 3001,
      host: '0.0.0.0',
      updateInterval: 5000, // 5 seconds
      maxClients: 100,
      enableCompression: true,
      corsOrigins: ['*'],
      authRequired: false,
      ...config,
    };

    this.setupEventListeners();
  }

  /**
   * Start the dashboard server
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      // Create HTTP server
      this.server = http.createServer(this.handleHttpRequest.bind(this));
      
      // Create WebSocket server
      this.wss = new WebSocketServer({
        server: this.server,
        perMessageDeflate: this.config.enableCompression,
      });

      this.wss.on('connection', this.handleWebSocketConnection.bind(this));

      // Start HTTP server
      await new Promise<void>((resolve, reject) => {
        this.server!.listen(this.config.port, this.config.host, (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      // Start periodic updates
      this.startPeriodicUpdates();
      
      this.isRunning = true;
      
      this.logger.info('Dashboard server started', {
        host: this.config.host,
        port: this.config.port,
        updateInterval: this.config.updateInterval,
        maxClients: this.config.maxClients,
      });

      this.emit('started', {
        host: this.config.host,
        port: this.config.port,
      });

    } catch (error) {
      this.logger.error('Failed to start dashboard server', error as Error);
      throw error;
    }
  }

  /**
   * Stop the dashboard server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Stop periodic updates
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
    }

    // Close all WebSocket connections
    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = undefined;
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }

    this.logger.info('Dashboard server stopped');
    this.emit('stopped');
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(message: DashboardResponse, subscription?: string): void {
    const messageStr = JSON.stringify(message);

    for (const client of this.clients.values()) {
      if (subscription && !client.subscriptions.has(subscription)) {
        continue;
      }

      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(messageStr);
      }
    }

    this.logger.debug('Broadcast message sent', {
      type: message.type,
      clientCount: this.clients.size,
      subscription,
    });
  }

  /**
   * Send message to specific client
   */
  sendToClient(clientId: string, message: DashboardResponse): void {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    client.ws.send(JSON.stringify(message));
    client.lastSeen = new Date();
  }

  /**
   * Get connected clients statistics
   */
  getClientStats(): {
    totalClients: number;
    clientsBySubscription: Record<string, number>;
    connections: Array<{
      id: string;
      connectedAt: Date;
      subscriptions: string[];
      metadata: DashboardClient['metadata'];
    }>;
  } {
    const clientsBySubscription: Record<string, number> = {};
    const connections: Array<{
      id: string;
      connectedAt: Date;
      subscriptions: string[];
      metadata: DashboardClient['metadata'];
    }> = [];

    for (const client of this.clients.values()) {
      // Count subscriptions
      for (const subscription of client.subscriptions) {
        clientsBySubscription[subscription] = (clientsBySubscription[subscription] || 0) + 1;
      }

      // Add to connections list
      connections.push({
        id: client.id,
        connectedAt: client.connectedAt,
        subscriptions: Array.from(client.subscriptions),
        metadata: client.metadata,
      });
    }

    return {
      totalClients: this.clients.size,
      clientsBySubscription,
      connections,
    };
  }

  // Private methods

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', this.config.corsOrigins.join(', '));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = req.url || '/';

    // Handle API endpoints
    if (url.startsWith('/api/')) {
      this.handleApiRequest(req, res);
      return;
    }

    // Serve static dashboard HTML
    if (url === '/' || url === '/dashboard') {
      this.serveDashboardHtml(res);
      return;
    }

    // Health check endpoint
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        clients: this.clients.size,
        uptime: process.uptime(),
      }));
      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private async handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '';
    
    try {
      if (url === '/api/dashboard-data') {
        const data = this.performanceMonitor.getDashboardData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (url === '/api/performance-trends') {
        const trends = this.performanceMonitor.getPerformanceTrends(24);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(trends));
        return;
      }

      if (url === '/api/metrics/export') {
        const format = req.url?.includes('format=prometheus') ? 'prometheus' : 'json';
        const metrics = this.performanceMonitor.exportMetrics(format as any);
        const contentType = format === 'prometheus' ? 'text/plain' : 'application/json';
        
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(metrics);
        return;
      }

      if (url === '/api/alerts') {
        const dashboardData = this.performanceMonitor.getDashboardData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dashboardData.activeAlerts));
        return;
      }

      if (url === '/api/client-stats') {
        const stats = this.getClientStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
      }

      // 404 for unknown API routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API endpoint not found' }));

    } catch (error) {
      this.logger.error('API request error', error as Error, { url });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private serveDashboardHtml(res: http.ServerResponse): void {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Scrivener MCP - Performance Dashboard</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
            color: #333;
        }
        .dashboard {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            max-width: 1200px;
            margin: 0 auto;
        }
        .card {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .card h3 {
            margin-top: 0;
            color: #2c3e50;
        }
        .metric {
            display: flex;
            justify-content: space-between;
            margin: 10px 0;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 4px;
        }
        .metric-value {
            font-weight: bold;
            color: #27ae60;
        }
        .alert {
            padding: 10px;
            margin: 10px 0;
            border-radius: 4px;
            border-left: 4px solid;
        }
        .alert.critical { border-color: #e74c3c; background: #fdf2f2; }
        .alert.error { border-color: #f39c12; background: #fef9e7; }
        .alert.warning { border-color: #f1c40f; background: #fffbf0; }
        .alert.info { border-color: #3498db; background: #f4f8fb; }
        .status {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
        }
        .status.healthy { background: #d4edda; color: #155724; }
        .status.warning { background: #fff3cd; color: #856404; }
        .status.critical { background: #f8d7da; color: #721c24; }
        #connection-status {
            position: fixed;
            top: 10px;
            right: 10px;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
        }
        .connected { background: #d4edda; color: #155724; }
        .disconnected { background: #f8d7da; color: #721c24; }
    </style>
</head>
<body>
    <div id="connection-status" class="disconnected">Disconnected</div>
    
    <h1>Scrivener MCP - Performance Dashboard</h1>
    
    <div class="dashboard">
        <div class="card">
            <h3>System Metrics</h3>
            <div id="system-metrics">
                <div class="metric">
                    <span>CPU Usage</span>
                    <span class="metric-value" id="cpu-usage">--</span>
                </div>
                <div class="metric">
                    <span>Memory Usage</span>
                    <span class="metric-value" id="memory-usage">--</span>
                </div>
                <div class="metric">
                    <span>Load Average</span>
                    <span class="metric-value" id="load-average">--</span>
                </div>
            </div>
        </div>

        <div class="card">
            <h3>Application Metrics</h3>
            <div id="app-metrics">
                <div class="metric">
                    <span>Requests/sec</span>
                    <span class="metric-value" id="requests-per-sec">--</span>
                </div>
                <div class="metric">
                    <span>Avg Response Time</span>
                    <span class="metric-value" id="avg-response-time">--</span>
                </div>
                <div class="metric">
                    <span>Error Rate</span>
                    <span class="metric-value" id="error-rate">--</span>
                </div>
            </div>
        </div>

        <div class="card">
            <h3>Database</h3>
            <div id="db-metrics">
                <div class="metric">
                    <span>Connections</span>
                    <span class="metric-value" id="db-connections">--</span>
                </div>
                <div class="metric">
                    <span>Cache Hit Rate</span>
                    <span class="metric-value" id="cache-hit-rate">--</span>
                </div>
                <div class="metric">
                    <span>Queries/sec</span>
                    <span class="metric-value" id="queries-per-sec">--</span>
                </div>
            </div>
        </div>

        <div class="card">
            <h3>Health Status</h3>
            <div id="health-status">
                <div class="metric">
                    <span>Overall</span>
                    <span class="status" id="overall-status">--</span>
                </div>
                <div id="service-status"></div>
            </div>
        </div>

        <div class="card">
            <h3>Active Alerts</h3>
            <div id="active-alerts">
                <p>No active alerts</p>
            </div>
        </div>

        <div class="card">
            <h3>Recent Performance</h3>
            <div id="recent-performance"></div>
        </div>
    </div>

    <script>
        let ws;
        let reconnectTimeout;

        function connect() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = \`\${protocol}//\${window.location.host}\`;
            
            ws = new WebSocket(wsUrl);
            
            ws.onopen = function() {
                console.log('Connected to dashboard');
                document.getElementById('connection-status').textContent = 'Connected';
                document.getElementById('connection-status').className = 'connected';
                
                // Subscribe to all data
                ws.send(JSON.stringify({
                    type: 'subscribe',
                    data: ['dashboard', 'alerts', 'performance'],
                    timestamp: new Date()
                }));
            };
            
            ws.onmessage = function(event) {
                const message = JSON.parse(event.data);
                handleMessage(message);
            };
            
            ws.onclose = function() {
                console.log('Disconnected from dashboard');
                document.getElementById('connection-status').textContent = 'Disconnected';
                document.getElementById('connection-status').className = 'disconnected';
                
                // Reconnect after 5 seconds
                reconnectTimeout = setTimeout(connect, 5000);
            };
            
            ws.onerror = function(error) {
                console.error('WebSocket error:', error);
            };
        }

        function handleMessage(message) {
            switch(message.type) {
                case 'data':
                    if (message.data.systemMetrics) {
                        updateSystemMetrics(message.data.systemMetrics);
                    }
                    if (message.data.applicationMetrics) {
                        updateApplicationMetrics(message.data.applicationMetrics);
                    }
                    if (message.data.healthStatus) {
                        updateHealthStatus(message.data.healthStatus);
                    }
                    if (message.data.activeAlerts) {
                        updateActiveAlerts(message.data.activeAlerts);
                    }
                    if (message.data.recentPerformance) {
                        updateRecentPerformance(message.data.recentPerformance);
                    }
                    break;
                case 'notification':
                    console.log('Notification:', message.data);
                    break;
            }
        }

        function updateSystemMetrics(metrics) {
            document.getElementById('cpu-usage').textContent = metrics.cpu.usage.toFixed(1) + '%';
            document.getElementById('memory-usage').textContent = metrics.memory.percentage.toFixed(1) + '%';
            document.getElementById('load-average').textContent = metrics.cpu.loadAverage[0].toFixed(2);
        }

        function updateApplicationMetrics(metrics) {
            document.getElementById('requests-per-sec').textContent = metrics.requests.perSecond.toFixed(1);
            document.getElementById('avg-response-time').textContent = metrics.requests.averageResponseTime.toFixed(0) + 'ms';
            document.getElementById('error-rate').textContent = (metrics.requests.errorRate * 100).toFixed(2) + '%';
            
            document.getElementById('db-connections').textContent = metrics.database.connections.active + '/' + metrics.database.connections.total;
            document.getElementById('cache-hit-rate').textContent = (metrics.database.cache.hitRate * 100).toFixed(1) + '%';
            document.getElementById('queries-per-sec').textContent = metrics.database.queries.perSecond.toFixed(1);
        }

        function updateHealthStatus(status) {
            const overallElement = document.getElementById('overall-status');
            overallElement.textContent = status.overall;
            overallElement.className = 'status ' + status.overall;

            const serviceStatusElement = document.getElementById('service-status');
            serviceStatusElement.innerHTML = status.services.map(service => 
                \`<div class="metric">
                    <span>\${service.name}</span>
                    <span class="status \${service.status}">\${service.status}</span>
                </div>\`
            ).join('');
        }

        function updateActiveAlerts(alerts) {
            const alertsElement = document.getElementById('active-alerts');
            
            if (alerts.length === 0) {
                alertsElement.innerHTML = '<p>No active alerts</p>';
                return;
            }

            alertsElement.innerHTML = alerts.map(alert => 
                \`<div class="alert \${alert.severity}">
                    <strong>\${alert.ruleName}</strong><br>
                    \${alert.message}<br>
                    <small>Triggered: \${new Date(alert.triggeredAt).toLocaleString()}</small>
                </div>\`
            ).join('');
        }

        function updateRecentPerformance(performance) {
            const performanceElement = document.getElementById('recent-performance');
            
            const operations = performance.operations.slice(0, 5).map(op => 
                \`<div class="metric">
                    <span>\${op.name}</span>
                    <span class="metric-value">\${op.avgTime.toFixed(2)}ms (\${op.count})</span>
                </div>\`
            ).join('');

            performanceElement.innerHTML = operations || '<p>No recent performance data</p>';
        }

        // Start connection
        connect();
    </script>
</body>
</html>
    `;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private handleWebSocketConnection(ws: WebSocket, req: http.IncomingMessage): void {
    if (this.clients.size >= this.config.maxClients) {
      ws.close(1013, 'Maximum clients exceeded');
      return;
    }

    const clientId = this.generateClientId();
    const client: DashboardClient = {
      id: clientId,
      ws,
      subscriptions: new Set(),
      connectedAt: new Date(),
      lastSeen: new Date(),
      metadata: {
        userAgent: req.headers['user-agent'],
        ip: req.socket.remoteAddress,
      },
    };

    this.clients.set(clientId, client);

    this.logger.info('Dashboard client connected', {
      clientId,
      userAgent: client.metadata.userAgent,
      ip: client.metadata.ip,
      totalClients: this.clients.size,
    });

    // Set up message handler
    ws.on('message', (data) => {
      this.handleWebSocketMessage(client, Buffer.from(data.toString()));
    });

    // Set up close handler
    ws.on('close', () => {
      this.clients.delete(clientId);
      this.logger.info('Dashboard client disconnected', {
        clientId,
        totalClients: this.clients.size,
      });
    });

    // Set up error handler
    ws.on('error', (error) => {
      this.logger.error('WebSocket error', error, { clientId });
    });

    // Send welcome message
    this.sendToClient(clientId, {
      type: 'ack',
      data: {
        clientId,
        serverTime: new Date(),
        message: 'Connected to dashboard server',
      },
      timestamp: new Date(),
    });

    this.emit('clientConnected', client);
  }

  private handleWebSocketMessage(client: DashboardClient, data: Buffer): void {
    try {
      const message: DashboardMessage = JSON.parse(data.toString());
      client.lastSeen = new Date();

      this.logger.debug('WebSocket message received', {
        clientId: client.id,
        type: message.type,
      });

      switch (message.type) {
        case 'subscribe':
          this.handleSubscribe(client, message);
          break;
        
        case 'unsubscribe':
          this.handleUnsubscribe(client, message);
          break;
        
        case 'request':
          this.handleRequest(client, message);
          break;
        
        case 'acknowledge':
          this.handleAcknowledge(client, message);
          break;
        
        case 'command':
          this.handleCommand(client, message);
          break;
        
        default:
          this.sendToClient(client.id, {
            type: 'error',
            error: `Unknown message type: ${message.type}`,
            timestamp: new Date(),
          });
      }
    } catch (error) {
      this.logger.error('Failed to handle WebSocket message', error as Error, {
        clientId: client.id,
      });

      this.sendToClient(client.id, {
        type: 'error',
        error: 'Invalid message format',
        timestamp: new Date(),
      });
    }
  }

  private handleSubscribe(client: DashboardClient, message: DashboardMessage): void {
    const subscriptions = Array.isArray(message.data) ? message.data : [message.data];
    
    for (const subscription of subscriptions) {
      client.subscriptions.add(subscription);
    }

    this.sendToClient(client.id, {
      type: 'ack',
      id: message.id,
      data: {
        subscriptions: Array.from(client.subscriptions),
        message: 'Subscribed successfully',
      },
      timestamp: new Date(),
    });

    // Send initial data for subscriptions
    if (client.subscriptions.has('dashboard')) {
      const dashboardData = this.performanceMonitor.getDashboardData();
      this.sendToClient(client.id, {
        type: 'data',
        data: dashboardData,
        timestamp: new Date(),
      });
    }
  }

  private handleUnsubscribe(client: DashboardClient, message: DashboardMessage): void {
    const subscriptions = Array.isArray(message.data) ? message.data : [message.data];
    
    for (const subscription of subscriptions) {
      client.subscriptions.delete(subscription);
    }

    this.sendToClient(client.id, {
      type: 'ack',
      id: message.id,
      data: {
        subscriptions: Array.from(client.subscriptions),
        message: 'Unsubscribed successfully',
      },
      timestamp: new Date(),
    });
  }

  private handleRequest(client: DashboardClient, message: DashboardMessage): void {
    const { type: requestType } = message.data || {};

    switch (requestType) {
      case 'dashboard-data':
        const dashboardData = this.performanceMonitor.getDashboardData();
        this.sendToClient(client.id, {
          type: 'data',
          id: message.id,
          data: dashboardData,
          timestamp: new Date(),
        });
        break;

      case 'performance-trends':
        const trends = this.performanceMonitor.getPerformanceTrends();
        this.sendToClient(client.id, {
          type: 'data',
          id: message.id,
          data: trends,
          timestamp: new Date(),
        });
        break;

      default:
        this.sendToClient(client.id, {
          type: 'error',
          id: message.id,
          error: `Unknown request type: ${requestType}`,
          timestamp: new Date(),
        });
    }
  }

  private handleAcknowledge(client: DashboardClient, message: DashboardMessage): void {
    const { alertId, note } = message.data || {};
    
    if (alertId) {
      // TODO: Implement acknowledgeAlert method
      // this.alertManager.acknowledgeAlert(alertId, client.id, note);
      
      this.sendToClient(client.id, {
        type: 'ack',
        id: message.id,
        data: { message: 'Alert acknowledged' },
        timestamp: new Date(),
      });
    } else {
      this.sendToClient(client.id, {
        type: 'error',
        id: message.id,
        error: 'Alert ID required for acknowledgment',
        timestamp: new Date(),
      });
    }
  }

  private handleCommand(client: DashboardClient, message: DashboardMessage): void {
    const { command, args } = message.data || {};

    // Only allow certain commands and check permissions
    const allowedCommands = ['test-alert', 'reset-metrics'];
    
    if (!allowedCommands.includes(command)) {
      this.sendToClient(client.id, {
        type: 'error',
        id: message.id,
        error: `Command not allowed: ${command}`,
        timestamp: new Date(),
      });
      return;
    }

    // Execute command
    try {
      switch (command) {
        case 'reset-metrics':
          // TODO: Implement resetMetrics method
          // this.performanceMonitor.resetMetrics();
          break;
      }

      this.sendToClient(client.id, {
        type: 'ack',
        id: message.id,
        data: { message: `Command executed: ${command}` },
        timestamp: new Date(),
      });
    } catch (error) {
      this.sendToClient(client.id, {
        type: 'error',
        id: message.id,
        error: `Command failed: ${(error as Error).message}`,
        timestamp: new Date(),
      });
    }
  }

  private setupEventListeners(): void {
    // Listen for performance monitor events
    this.performanceMonitor.on('systemMetrics', (metrics) => {
      this.broadcast({
        type: 'data',
        data: { systemMetrics: metrics },
        timestamp: new Date(),
      }, 'dashboard');
    });

    this.performanceMonitor.on('applicationMetrics', (metrics) => {
      this.broadcast({
        type: 'data',
        data: { applicationMetrics: metrics },
        timestamp: new Date(),
      }, 'dashboard');
    });

    this.performanceMonitor.on('alertTriggered', (alert) => {
      this.broadcast({
        type: 'notification',
        data: {
          type: 'alert',
          severity: alert.severity,
          message: `Alert triggered: ${alert.ruleName}`,
          alert,
        },
        timestamp: new Date(),
      }, 'alerts');
    });

    // Listen for alert manager events
    this.alertManager.on('alertSent', (event) => {
      this.broadcast({
        type: 'notification',
        data: {
          type: 'alert-sent',
          message: `Alert sent: ${event.alert.ruleName}`,
          results: event.results,
        },
        timestamp: new Date(),
      }, 'alerts');
    });
  }

  private startPeriodicUpdates(): void {
    this.updateTimer = setInterval(() => {
      if (this.clients.size === 0) return;

      const dashboardData = this.performanceMonitor.getDashboardData();
      
      this.broadcast({
        type: 'data',
        data: dashboardData,
        timestamp: new Date(),
      }, 'dashboard');

    }, this.config.updateInterval);
  }

  private generateClientId(): string {
    return `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}