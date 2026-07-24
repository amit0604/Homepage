const express = require('express');
const router = express.Router();
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');
const Notification = collections.notifications;

// Get all notifications
router.get('/notifications', async (req, res) => {
  try {
    const notifications = await Notification.all();
    notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add new notification
router.post('/notifications', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  const { title, description, icon, link, isVisible } = req.body;
  
  try {
    if (!title || !description) {
      return res.status(400).json({ message: 'Title and description are required' });
    }

    const savedNotification = await Notification.insert({
      title,
      description,
      icon,
      link,
      isVisible: isVisible !== undefined ? isVisible : true // Default to true if not specified
    });
    res.status(201).json(savedNotification);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete notification
router.delete('/notifications/:id', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const deletedNotification = await Notification.deleteById(req.params.id);
    
    if (!deletedNotification) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    res.json({ message: 'Notification deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update notification
router.put('/notifications/:id', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const { title, description, icon, link, isVisible } = req.body;
    const updatedNotification = await Notification.updateById(req.params.id, {
      title,
      description,
      icon,
      link,
      isVisible,
    });
    
    if (!updatedNotification) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    res.json(updatedNotification);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;