const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true
  },
  fullname: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  conversations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' }]
});

module.exports = mongoose.model('User', userSchema);
