/**
 * Alert Management System with Multiple Notification Channels
 */

import { EventEmitter } from 'events';
import * as nodemailer from 'nodemailer';
import { EnhancedLogger } from '../core/enhanced-logger.js';
import type { Alert, AlertRule } from './performance-monitor.js';

export interface NotificationChannel {
  name: string;
  type: 'email' | 'slack' | 'webhook' | 'sms' | 'pagerduty';
  config: Record<string, unknown>;
  enabled: boolean;
  failureCount: number;
  lastFailure?: Date;
  rateLimitMs?: number;
  lastSent?: Date;
}

export interface AlertTemplate {
  id: string;
  name: string;
  severity: Alert['severity'];
  subject: string;
  body: string;
  variables: string[];
}

export interface NotificationResult {
  channel: string;
  success: boolean;
  error?: string;
  sentAt: Date;
  messageId?: string;
}

export interface EscalationRule {
  id: string;
  name: string;
  conditions: {
    severity: Alert['severity'][];
    unacknowledgedDuration: number; // milliseconds
    tags?: string[];
  };
  actions: {
    channels: string[];
    escalateAfter: number; // milliseconds
    maxEscalations: number;
  };
  enabled: boolean;
}

/**
 * Comprehensive alert management with multiple notification channels
 */
export class AlertManager extends EventEmitter {
  private logger: EnhancedLogger;
  private channels = new Map<string, NotificationChannel>();
  private templates = new Map<string, AlertTemplate>();
  private escalationRules = new Map<string, EscalationRule>();
  private pendingNotifications = new Map<string, {
    alert: Alert;
    channels: string[];
    attempts: number;
    nextRetry: Date;
  }>();
  private notificationHistory: Array<{
    alertId: string;
    channel: string;
    result: NotificationResult;
  }> = [];
  private processingTimer?: NodeJS.Timeout;

  constructor(logger: EnhancedLogger) {
    super();
    this.logger = logger;
    this.setupDefaultTemplates();
    this.startNotificationProcessor();
  }

  /**
   * Add notification channel
   */
  addChannel(channel: NotificationChannel): void {
    this.channels.set(channel.name, channel);
    this.logger.info('Notification channel added', {
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled,
    });
    this.emit('channelAdded', channel);
  }

  /**
   * Remove notification channel
   */
  removeChannel(channelName: string): void {
    if (this.channels.delete(channelName)) {
      this.logger.info('Notification channel removed', { name: channelName });
      this.emit('channelRemoved', channelName);
    }
  }

  /**
   * Add alert template
   */
  addTemplate(template: AlertTemplate): void {
    this.templates.set(template.id, template);
    this.logger.info('Alert template added', {
      id: template.id,
      name: template.name,
      severity: template.severity,
    });
  }

  /**
   * Add escalation rule
   */
  addEscalationRule(rule: EscalationRule): void {
    this.escalationRules.set(rule.id, rule);
    this.logger.info('Escalation rule added', {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
    });
  }

  /**
   * Send alert notification
   */
  async sendAlert(
    alert: Alert,
    channels?: string[],
    template?: string
  ): Promise<NotificationResult[]> {
    const targetChannels = channels || this.getDefaultChannelsForSeverity(alert.severity);
    const templateToUse = template || this.getDefaultTemplateForSeverity(alert.severity);

    this.logger.info('Sending alert notification', {
      alertId: alert.id,
      severity: alert.severity,
      channels: targetChannels,
      template: templateToUse,
    });

    const results: NotificationResult[] = [];

    for (const channelName of targetChannels) {
      const channel = this.channels.get(channelName);
      if (!channel || !channel.enabled) {
        this.logger.warn('Channel not found or disabled', { channel: channelName });
        continue;
      }

      // Check rate limiting
      if (this.isRateLimited(channel)) {
        this.logger.warn('Channel rate limited', { channel: channelName });
        continue;
      }

      try {
        const result = await this.sendToChannel(alert, channel, templateToUse);
        results.push(result);
        
        // Update channel state
        channel.lastSent = new Date();
        channel.failureCount = 0;
        
        this.notificationHistory.push({
          alertId: alert.id,
          channel: channelName,
          result,
        });

      } catch (error) {
        const result: NotificationResult = {
          channel: channelName,
          success: false,
          error: (error as Error).message,
          sentAt: new Date(),
        };
        
        results.push(result);
        
        // Update channel failure state
        channel.failureCount++;
        channel.lastFailure = new Date();
        
        this.logger.error('Failed to send notification', error as Error, {
          channel: channelName,
          alertId: alert.id,
        });

        // Queue for retry
        this.queueForRetry(alert, channelName);
      }
    }

    this.emit('alertSent', { alert, results });
    return results;
  }

  /**
   * Test notification channel
   */
  async testChannel(channelName: string): Promise<NotificationResult> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      throw new Error(`Channel not found: ${channelName}`);
    }

    const testAlert: Alert = {
      id: `test-${Date.now()}`,
      ruleId: 'test',
      ruleName: 'Test Alert',
      severity: 'info',
      metric: 'test.metric',
      currentValue: 100,
      threshold: 50,
      operator: 'gt',
      message: 'This is a test alert to verify channel configuration',
      triggeredAt: new Date(),
      acknowledged: false,
      metadata: { test: true },
    };

    return this.sendToChannel(testAlert, channel, 'test');
  }

  /**
   * Get notification history
   */
  getNotificationHistory(limit = 100): Array<{
    alertId: string;
    channel: string;
    result: NotificationResult;
  }> {
    return this.notificationHistory.slice(-limit);
  }

  /**
   * Get channel statistics
   */
  getChannelStats(): Record<string, {
    enabled: boolean;
    totalSent: number;
    failures: number;
    successRate: number;
    lastSent?: Date;
    lastFailure?: Date;
  }> {
    const stats: Record<string, any> = {};

    for (const [name, channel] of this.channels) {
      const channelHistory = this.notificationHistory.filter(h => h.channel === name);
      const successful = channelHistory.filter(h => h.result.success).length;
      const total = channelHistory.length;

      stats[name] = {
        enabled: channel.enabled,
        totalSent: total,
        failures: channel.failureCount,
        successRate: total > 0 ? successful / total : 0,
        lastSent: channel.lastSent,
        lastFailure: channel.lastFailure,
      };
    }

    return stats;
  }

  /**
   * Process escalation rules
   */
  processEscalations(alerts: Alert[]): void {
    for (const rule of this.escalationRules.values()) {
      if (!rule.enabled) continue;

      for (const alert of alerts) {
        if (this.shouldEscalate(alert, rule)) {
          this.escalateAlert(alert, rule);
        }
      }
    }
  }

  /**
   * Close alert manager
   */
  async close(): Promise<void> {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
    }

    this.removeAllListeners();
    this.logger.info('Alert manager closed');
  }

  // Private methods

  private async sendToChannel(
    alert: Alert,
    channel: NotificationChannel,
    templateId: string
  ): Promise<NotificationResult> {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    const message = this.renderTemplate(template, alert);

    switch (channel.type) {
      case 'email':
        return this.sendEmail(alert, channel, message);
      case 'slack':
        return this.sendSlack(alert, channel, message);
      case 'webhook':
        return this.sendWebhook(alert, channel, message);
      case 'sms':
        return this.sendSms(alert, channel, message);
      case 'pagerduty':
        return this.sendPagerDuty(alert, channel, message);
      default:
        throw new Error(`Unsupported channel type: ${channel.type}`);
    }
  }

  private async sendEmail(
    alert: Alert,
    channel: NotificationChannel,
    message: { subject: string; body: string }
  ): Promise<NotificationResult> {
    const config = channel.config as {
      host: string;
      port: number;
      secure: boolean;
      auth: { user: string; pass: string };
      from: string;
      to: string[];
    };

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth,
    });

    const info = await transporter.sendMail({
      from: config.from,
      to: config.to.join(', '),
      subject: message.subject,
      html: message.body,
    });

    return {
      channel: channel.name,
      success: true,
      sentAt: new Date(),
      messageId: info.messageId,
    };
  }

  private async sendSlack(
    alert: Alert,
    channel: NotificationChannel,
    message: { subject: string; body: string }
  ): Promise<NotificationResult> {
    const config = channel.config as { webhookUrl: string; channel?: string };

    const payload = {
      channel: config.channel,
      text: message.subject,
      attachments: [
        {
          color: this.getSeverityColor(alert.severity),
          fields: [
            { title: 'Metric', value: alert.metric, short: true },
            { title: 'Current Value', value: alert.currentValue.toString(), short: true },
            { title: 'Threshold', value: alert.threshold.toString(), short: true },
            { title: 'Triggered At', value: alert.triggeredAt.toISOString(), short: true },
          ],
          text: message.body,
        },
      ],
    };

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
    }

    return {
      channel: channel.name,
      success: true,
      sentAt: new Date(),
    };
  }

  private async sendWebhook(
    alert: Alert,
    channel: NotificationChannel,
    message: { subject: string; body: string }
  ): Promise<NotificationResult> {
    const config = channel.config as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
    };

    const payload = {
      alert,
      message,
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(config.url, {
      method: config.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook error: ${response.status} ${response.statusText}`);
    }

    return {
      channel: channel.name,
      success: true,
      sentAt: new Date(),
    };
  }

  private async sendSms(
    alert: Alert,
    channel: NotificationChannel,
    message: { subject: string; body: string }
  ): Promise<NotificationResult> {
    // SMS implementation would depend on your SMS provider (Twilio, AWS SNS, etc.)
    // This is a placeholder implementation
    const config = channel.config as {
      provider: 'twilio' | 'aws-sns';
      apiKey: string;
      apiSecret: string;
      from: string;
      to: string[];
    };

    // Simulate SMS sending
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      channel: channel.name,
      success: true,
      sentAt: new Date(),
      messageId: `sms-${Date.now()}`,
    };
  }

  private async sendPagerDuty(
    alert: Alert,
    channel: NotificationChannel,
    message: { subject: string; body: string }
  ): Promise<NotificationResult> {
    const config = channel.config as {
      routingKey: string;
      apiUrl?: string;
    };

    const payload = {
      routing_key: config.routingKey,
      event_action: alert.resolvedAt ? 'resolve' : 'trigger',
      dedup_key: alert.id,
      payload: {
        summary: message.subject,
        source: 'scrivener-mcp',
        severity: alert.severity,
        component: alert.metric,
        group: 'monitoring',
        class: 'alert',
        custom_details: {
          metric: alert.metric,
          current_value: alert.currentValue,
          threshold: alert.threshold,
          operator: alert.operator,
          triggered_at: alert.triggeredAt.toISOString(),
        },
      },
    };

    const response = await fetch(config.apiUrl || 'https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`PagerDuty API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    return {
      channel: channel.name,
      success: true,
      sentAt: new Date(),
      messageId: result.dedup_key,
    };
  }

  private renderTemplate(template: AlertTemplate, alert: Alert): { subject: string; body: string } {
    const variables = {
      alertId: alert.id,
      ruleName: alert.ruleName,
      severity: alert.severity,
      metric: alert.metric,
      currentValue: alert.currentValue,
      threshold: alert.threshold,
      operator: alert.operator,
      message: alert.message,
      triggeredAt: alert.triggeredAt.toISOString(),
      resolvedAt: alert.resolvedAt?.toISOString() || 'Not resolved',
      ...alert.metadata,
    };

    let subject = template.subject;
    let body = template.body;

    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      subject = subject.replace(new RegExp(placeholder, 'g'), String(value));
      body = body.replace(new RegExp(placeholder, 'g'), String(value));
    }

    return { subject, body };
  }

  private setupDefaultTemplates(): void {
    const templates: AlertTemplate[] = [
      {
        id: 'default',
        name: 'Default Alert Template',
        severity: 'info',
        subject: '{{severity}} Alert: {{ruleName}}',
        body: `
          <h2>Alert: {{ruleName}}</h2>
          <p><strong>Severity:</strong> {{severity}}</p>
          <p><strong>Message:</strong> {{message}}</p>
          <p><strong>Metric:</strong> {{metric}}</p>
          <p><strong>Current Value:</strong> {{currentValue}}</p>
          <p><strong>Threshold:</strong> {{threshold}}</p>
          <p><strong>Triggered At:</strong> {{triggeredAt}}</p>
          <p><strong>Alert ID:</strong> {{alertId}}</p>
        `,
        variables: ['alertId', 'ruleName', 'severity', 'message', 'metric', 'currentValue', 'threshold', 'triggeredAt'],
      },
      {
        id: 'critical',
        name: 'Critical Alert Template',
        severity: 'critical',
        subject: '🚨 CRITICAL ALERT: {{ruleName}}',
        body: `
          <h2 style="color: red;">🚨 CRITICAL ALERT: {{ruleName}}</h2>
          <p><strong style="color: red;">This is a critical system alert that requires immediate attention!</strong></p>
          <p><strong>Message:</strong> {{message}}</p>
          <p><strong>Metric:</strong> {{metric}}</p>
          <p><strong>Current Value:</strong> {{currentValue}}</p>
          <p><strong>Threshold:</strong> {{threshold}}</p>
          <p><strong>Triggered At:</strong> {{triggeredAt}}</p>
          <p><strong>Alert ID:</strong> {{alertId}}</p>
          <p><em>Please investigate immediately and acknowledge this alert.</em></p>
        `,
        variables: ['alertId', 'ruleName', 'message', 'metric', 'currentValue', 'threshold', 'triggeredAt'],
      },
      {
        id: 'test',
        name: 'Test Template',
        severity: 'info',
        subject: 'Test Alert - Channel Configuration Verification',
        body: `
          <h2>Test Alert</h2>
          <p>This is a test message to verify your notification channel configuration.</p>
          <p>If you received this message, your channel is working correctly.</p>
          <p><strong>Sent At:</strong> {{triggeredAt}}</p>
        `,
        variables: ['triggeredAt'],
      },
    ];

    for (const template of templates) {
      this.addTemplate(template);
    }
  }

  private getDefaultChannelsForSeverity(severity: Alert['severity']): string[] {
    switch (severity) {
      case 'critical':
        return ['email', 'pagerduty', 'slack'];
      case 'error':
        return ['email', 'slack'];
      case 'warning':
        return ['slack'];
      case 'info':
      default:
        return ['slack'];
    }
  }

  private getDefaultTemplateForSeverity(severity: Alert['severity']): string {
    return severity === 'critical' ? 'critical' : 'default';
  }

  private getSeverityColor(severity: Alert['severity']): string {
    switch (severity) {
      case 'critical': return 'danger';
      case 'error': return 'warning';
      case 'warning': return 'warning';
      case 'info': return 'good';
      default: return 'good';
    }
  }

  private isRateLimited(channel: NotificationChannel): boolean {
    if (!channel.rateLimitMs || !channel.lastSent) return false;
    
    const timeSinceLastSent = Date.now() - channel.lastSent.getTime();
    return timeSinceLastSent < channel.rateLimitMs;
  }

  private queueForRetry(alert: Alert, channelName: string): void {
    const existing = this.pendingNotifications.get(alert.id);
    const retryDelay = existing ? Math.min(existing.attempts * 30000, 300000) : 30000; // Max 5 minutes

    this.pendingNotifications.set(alert.id, {
      alert,
      channels: [channelName],
      attempts: existing ? existing.attempts + 1 : 1,
      nextRetry: new Date(Date.now() + retryDelay),
    });
  }

  private shouldEscalate(alert: Alert, rule: EscalationRule): boolean {
    // Check severity match
    if (!rule.conditions.severity.includes(alert.severity)) return false;

    // Check if alert is unacknowledged for required duration
    if (alert.acknowledged) return false;

    const unacknowledgedDuration = Date.now() - alert.triggeredAt.getTime();
    if (unacknowledgedDuration < rule.conditions.unacknowledgedDuration) return false;

    // Check tags if specified
    if (rule.conditions.tags) {
      const alertTags = alert.metadata.tags as string[] || [];
      const hasRequiredTags = rule.conditions.tags.some(tag => alertTags.includes(tag));
      if (!hasRequiredTags) return false;
    }

    return true;
  }

  private async escalateAlert(alert: Alert, rule: EscalationRule): Promise<void> {
    this.logger.warn('Escalating alert', {
      alertId: alert.id,
      escalationRule: rule.name,
      severity: alert.severity,
    });

    // Send escalation notification
    await this.sendAlert(alert, rule.actions.channels, 'critical');

    this.emit('alertEscalated', { alert, rule });
  }

  private startNotificationProcessor(): void {
    this.processingTimer = setInterval(() => {
      this.processRetries();
    }, 30000); // Process retries every 30 seconds
  }

  private async processRetries(): Promise<void> {
    const now = new Date();
    const toRetry: string[] = [];

    for (const [alertId, pending] of this.pendingNotifications) {
      if (now >= pending.nextRetry && pending.attempts < 3) {
        toRetry.push(alertId);
      } else if (pending.attempts >= 3) {
        // Give up after 3 attempts
        this.logger.error('Giving up on notification after 3 attempts', {
          alertId,
          channels: pending.channels,
        });
        this.pendingNotifications.delete(alertId);
      }
    }

    for (const alertId of toRetry) {
      const pending = this.pendingNotifications.get(alertId)!;
      try {
        await this.sendAlert(pending.alert, pending.channels);
        this.pendingNotifications.delete(alertId);
      } catch (error) {
        this.logger.warn('Retry notification failed', { error: (error as Error).message, alertId });
        this.queueForRetry(pending.alert, pending.channels[0]);
      }
    }
  }
}