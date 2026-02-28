/**
 * Diagnostic logging system — writes to persistent files so we can analyze issues.
 * 
 * Usage:
 *   const diag = new DiagnosticsLogger('voice');
 *   diag.log('myEvent', { payload: data });
 *   
 * Logs are written to: logs/voice-YYYY-MM-DD.log (rotates daily)
 * Also outputs to console with timestamps.
 */

const fs = require('fs');
const path = require('path');

class DiagnosticsLogger {
  constructor(name) {
    this.name = name;
    this.logsDir = path.join(__dirname, '..', 'logs');
    
    // Ensure logs directory exists
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    this.currentDate = this.getDateString();
    this.buffer = []; // Buffer logs for batch writes
    this.writeInterval = setInterval(() => this.flush(), 1000); // Flush every 1s
    this.maxFileSize = 50 * 1024 * 1024; // Rotate at 50MB
  }

  getDateString() {
    return new Date().toISOString().split('T')[0];
  }

  getLogFilePath() {
    return path.join(this.logsDir, `${this.name}-${this.currentDate}.log`);
  }

  /**
   * Log an event with structured data.
   * @param {string} event - Event name (e.g., 'frame_drop', 'encode_error')
   * @param {object} data - Event payload
   */
  log(event, data = {}) {
    const now = new Date();
    const timestamp = now.toISOString();
    const entry = {
      timestamp,
      event,
      ...data,
    };

    // Console output with colors
    console.log(`[${this.name.toUpperCase()}] ${event}`, data);

    // Buffer for file write
    this.buffer.push(JSON.stringify(entry));

    // Flush if buffer gets big
    if (this.buffer.length > 100) {
      this.flush();
    }
  }

  /**
   * Log a metric (for time-series data).
   * @param {string} metric - Metric name
   * @param {number} value - Metric value
   * @param {object} tags - Optional tags (e.g., { username: 'alex', sessionId: '123' })
   */
  metric(metric, value, tags = {}) {
    const now = new Date();
    const timestamp = now.toISOString();
    this.log(`metric_${metric}`, {
      value,
      timestamp,
      ...tags,
    });
  }

  /**
   * Flush buffered logs to disk.
   */
  flush() {
    if (this.buffer.length === 0) return;

    const today = this.getDateString();
    if (today !== this.currentDate) {
      // Date changed — start new file
      this.currentDate = today;
    }

    const filePath = this.getLogFilePath();
    const content = this.buffer.join('\n') + '\n';

    try {
      fs.appendFileSync(filePath, content, 'utf8');
      this.buffer = [];

      // Check file size and rotate if needed
      const stats = fs.statSync(filePath);
      if (stats.size > this.maxFileSize) {
        const rolloverPath = filePath.replace('.log', `.${Date.now()}.log`);
        fs.renameSync(filePath, rolloverPath);
      }
    } catch (err) {
      console.error('[Diagnostics] Failed to write logs:', err.message);
    }
  }

  /**
   * Get recent logs from the current day's file.
   * @param {number} lines - Number of lines to read (default 1000)
   * @returns {string} - Log content
   */
  getTailLogs(lines = 1000) {
    const filePath = this.getLogFilePath();
    if (!fs.existsSync(filePath)) return 'No logs yet.';

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const allLines = content.split('\n').filter(l => l.trim());
      return allLines.slice(-lines).join('\n');
    } catch (err) {
      return `Error reading logs: ${err.message}`;
    }
  }

  /**
   * Get all log files available.
   */
  listLogFiles() {
    try {
      return fs.readdirSync(this.logsDir)
        .filter(f => f.startsWith(this.name))
        .sort()
        .reverse();
    } catch (err) {
      return [];
    }
  }

  /**
   * Read a specific log file.
   */
  readLogFile(filename) {
    const filePath = path.join(this.logsDir, filename);
    if (!fs.existsSync(filePath)) return 'File not found.';
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      return `Error reading file: ${err.message}`;
    }
  }

  /**
   * Export a summary of diagnostics.
   */
  exportSummary() {
    const logs = this.getTailLogs(10000); // Last 10k lines
    const lines = logs.split('\n').map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Aggregate metrics
    const summary = {
      totalEvents: lines.length,
      eventsByType: {},
      metrics: {},
      errors: [],
    };

    lines.forEach(entry => {
      // Count event types
      if (!summary.eventsByType[entry.event]) {
        summary.eventsByType[entry.event] = 0;
      }
      summary.eventsByType[entry.event]++;

      // Collect errors
      if (entry.event.includes('error') || entry.event.includes('drop')) {
        summary.errors.push({
          timestamp: entry.timestamp,
          event: entry.event,
          details: entry,
        });
      }

      // Track metrics
      if (entry.event.startsWith('metric_')) {
        const metricName = entry.event.replace('metric_', '');
        if (!summary.metrics[metricName]) {
          summary.metrics[metricName] = [];
        }
        summary.metrics[metricName].push(entry.value);
      }
    });

    // Calculate metric stats
    const metricStats = {};
    for (const [name, values] of Object.entries(summary.metrics)) {
      metricStats[name] = {
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
      };
    }

    return {
      ...summary,
      metricStats,
      ErrorCount: summary.errors.length,
      topErrors: summary.errors.slice(-50),
    };
  }

  close() {
    clearInterval(this.writeInterval);
    this.flush();
  }
}

module.exports = DiagnosticsLogger;
