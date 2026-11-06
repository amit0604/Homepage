// app.js or routes/server.js
const express = require('express');
const { collections } = require('../repositories/jsonStore');
const router = express.Router();
const Server = collections.servers;
const { logFailure } = require('../utils/failureLog');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');

router.use('/servers', jwtMiddleware, isAdminMiddleware);

// Route to add a new server
router.post('/servers', async (req, res) => {
    try {
        const { name, url, isAdminOnly, logoUrl, logoAutoSize } = req.body;
        if (!name || !url) {
            return res.status(400).send('Name and URL are required');
        }
        if (!isValidUrlOrAddress(url)) {
            return res.status(400).send(`${url} is not a valid URL or IP address!`);
        }

        const existingServer = await Server.findOne((server) => server.name === name);
        if (existingServer) {
            return res.status(409).send('Server name already exists');
        }

        const logoAutoSizeFlag =
          logoAutoSize === undefined || logoAutoSize === null
            ? true
            : logoAutoSize === true || logoAutoSize === 'true';

        // Ensure isAdminOnly is boolean (default to false if not provided)
        const server = await Server.insert({
            name,
            url,
            isAdminOnly: isAdminOnly === true || isAdminOnly === 'true',
            logoUrl: typeof logoUrl === 'string' ? logoUrl.trim() : '',
            logoAutoSize: logoAutoSizeFlag,
        });
        res.status(201).send(server);
    } catch (error) {
        logFailure('servers.create', error, { path: req.path });
        res.status(400).send(error.message);
    }
});

// Route to update an existing server
router.put('/servers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, url, isAdminOnly, logoUrl, logoAutoSize } = req.body;
        if (url && !isValidUrlOrAddress(url)) {
            return res.status(400).send(`${url} is not a valid URL or IP address!`);
        }
        if (name) {
            const duplicate = await Server.findOne((server) => server.name === name && server._id !== id);
            if (duplicate) {
                return res.status(409).send('Server name already exists');
            }
        }

        const patch = {};
        if (name !== undefined) patch.name = name;
        if (url !== undefined) patch.url = url;
        if (isAdminOnly !== undefined) {
            patch.isAdminOnly = isAdminOnly === true || isAdminOnly === 'true';
        }
        if (logoUrl !== undefined) {
            patch.logoUrl = typeof logoUrl === 'string' ? logoUrl.trim() : '';
        }
        if (logoAutoSize !== undefined) {
            patch.logoAutoSize = logoAutoSize === true || logoAutoSize === 'true';
        }

        const updatedServer = await Server.updateById(id, patch);
        if (!updatedServer) return res.status(404).send('Server not found');
        res.send(updatedServer);
    } catch (error) {
        logFailure('servers.update', error, { path: req.path, id: req.params.id });
        res.status(400).send(error.message);
    }
});

// Route to delete a server
router.delete('/servers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deletedServer = await Server.deleteById(id);
        if (!deletedServer) return res.status(404).send('Server not found');
        res.send(deletedServer);
    } catch (error) {
        logFailure('servers.delete', error, { path: req.path, id: req.params.id });
        res.status(500).send(error.message);
    }
});

router.get('/servers', async (req, res) => {
    try {
      const { q } = req.query;
  
      const query = q ? q.toLowerCase() : null;
      const servers = await Server.find((server) => {
        return !query || (server.name || '').toLowerCase().includes(query);
      });
      res.json(servers);
    } catch (error) {
      logFailure('servers.list', error, { path: req.path });
      res.status(500).json({ error: error.message });
    }
  });
  
  function isValidUrlOrAddress(value) {
    return /^(https?:\/\/)?((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([\w.-]+(\.[\w.-]+)*))(:\d+)?(\/[^\s]*)?(\?[^#]*)?(#.*)?$/.test(value);
  }

// Export the router
module.exports = router;