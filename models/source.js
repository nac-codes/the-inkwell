const mongoose = require('mongoose');

const sourceSchema = new mongoose.Schema({
  fieldname: String,
  originalname: String,
  mimetype: String,
  size: Number,
  // Additional attributes
  url: String,
  title: String,
  summary: String,
  author: String,
  publicationYear: Number,  // Use camelCase for JavaScript naming conventions
  publisher: String,
  publicationLocation: String
});

const Source = mongoose.model('Source', sourceSchema);

module.exports = Source;
