const express = require('express');
const sql = require('mssql');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const { BlobServiceClient } = require('@azure/storage-blob');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

let pool;
let blobContainer;
let isReady = false;

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (!isReady) return res.status(503).json({ error: 'Service starting up, retry in a few seconds.' });
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ status: 'starting', db: 'not ready', storage: 'not ready' });
    await pool.request().query('SELECT 1');
    res.json({ status: 'healthy', db: 'connected', storage: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/api/tasks', async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM Tasks';
    const request = pool.request();
    if (status) { query += ' WHERE Status = @status'; request.input('status', sql.NVarChar, status); }
    query += ' ORDER BY CreatedAt DESC';
    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM Tasks WHERE Id = @id');
    if (!result.recordset.length) return res.status(404).json({ error: 'Task not found' });
    res.json(result.recordset[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, assignee, priority } = req.body;
    const result = await pool.request()
      .input('title', sql.NVarChar, title)
      .input('description', sql.NVarChar, description || '')
      .input('assignee', sql.NVarChar, assignee || '')
      .input('priority', sql.NVarChar, priority || 'Medium')
      .query(`INSERT INTO Tasks (Title, Description, Assignee, Priority, Status, CreatedAt)
              OUTPUT INSERTED.*
              VALUES (@title, @description, @assignee, @priority, 'Open', GETUTCDATE())`);
    res.status(201).json(result.recordset[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const { title, description, assignee, priority, status } = req.body;
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('title', sql.NVarChar, title)
      .input('description', sql.NVarChar, description)
      .input('assignee', sql.NVarChar, assignee)
      .input('priority', sql.NVarChar, priority)
      .input('status', sql.NVarChar, status)
      .query(`UPDATE Tasks SET Title=@title, Description=@description,
              Assignee=@assignee, Priority=@priority, Status=@status
              OUTPUT INSERTED.*
              WHERE Id = @id`);
    if (!result.recordset.length) return res.status(404).json({ error: 'Task not found' });
    res.json(result.recordset[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('DELETE FROM Tasks WHERE Id = @id');
    res.status(204).send();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/:id/attachments', upload.single('file'), async (req, res) => {
  try {
    const taskId = req.params.id;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    const blobName = `${taskId}/${Date.now()}-${file.originalname}`;
    const blockBlob = blobContainer.getBlockBlobClient(blobName);
    await blockBlob.uploadData(file.buffer, {
      blobHTTPHeaders: { blobContentType: file.mimetype }
    });
    await pool.request()
      .input('taskId', sql.Int, taskId)
      .input('fileName', sql.NVarChar, file.originalname)
      .input('blobName', sql.NVarChar, blobName)
      .input('size', sql.Int, file.size)
      .query(`INSERT INTO Attachments (TaskId, FileName, BlobName, Size, UploadedAt)
              VALUES (@taskId, @fileName, @blobName, @size, GETUTCDATE())`);
    res.status(201).json({ message: 'Uploaded', blobName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks/:id/attachments', async (req, res) => {
  try {
    const result = await pool.request()
      .input('taskId', sql.Int, req.params.id)
      .query('SELECT * FROM Attachments WHERE TaskId = @taskId ORDER BY UploadedAt DESC');
    const attachments = result.recordset.map((att) => {
      const blockBlob = blobContainer.getBlockBlobClient(att.BlobName);
      return { ...att, downloadUrl: blockBlob.url };
    });
    res.json(attachments);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function initServices() {
  const credential = new DefaultAzureCredential();
  const kvUrl = process.env.KEY_VAULT_URL;
  const kvClient = new SecretClient(kvUrl, credential);
  const connSecret = await kvClient.getSecret('sql-connection-string');
  pool = await sql.connect(connSecret.value);
  console.log('Connected to Azure SQL');
  const storageConnSecret = await kvClient.getSecret('storage-connection-string');
  const blobService = BlobServiceClient.fromConnectionString(storageConnSecret.value);
  blobContainer = blobService.getContainerClient('attachments');
  console.log('Connected to Blob Storage');
  isReady = true;
  console.log('Service fully ready');
}

initServices().catch(err => {
  console.error('Init failed:', err.message);
});