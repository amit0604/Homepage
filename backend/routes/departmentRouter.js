const express = require('express');
const { jwtMiddleware, isAdminMiddleware } = require('../middlewares/jwtMiddleware');
const { collections } = require('../repositories/jsonStore');

const router = express.Router();
const Department = collections.departments;
const { logFailure } = require('../utils/failureLog');

router.get('/departments', async (req, res) => {
  try {
    const departments = await Department.all();
    departments.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json(departments);
  } catch (error) {
    logFailure('departments.list', error, { path: req.path });
    res.status(500).json({ message: error.message });
  }
});

router.post('/departments', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    const normalizedName = typeof name === 'string' ? name.trim() : '';

    if (!normalizedName) {
      return res.status(400).json({ message: 'Department name is required' });
    }

    const existingDepartment = await Department.findOne(
      (department) => (department.name || '').toLowerCase() === normalizedName.toLowerCase()
    );
    if (existingDepartment) {
      return res.status(409).json({ message: 'Department already exists' });
    }

    const department = await Department.insert({ name: normalizedName });
    res.status(201).json(department);
  } catch (error) {
    logFailure('departments.create', error, { path: req.path });
    res.status(400).json({ message: error.message });
  }
});

router.delete('/departments/:id', jwtMiddleware, isAdminMiddleware, async (req, res) => {
  try {
    const deletedDepartment = await Department.deleteById(req.params.id);

    if (!deletedDepartment) {
      return res.status(404).json({ message: 'Department not found' });
    }

    res.json(deletedDepartment);
  } catch (error) {
    logFailure('departments.delete', error, { path: req.path, id: req.params.id });
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
