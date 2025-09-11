const mongoose = require('mongoose');

const appStateSchema= new mongoose.Schema({
    singleTonKey: {type: String, default: 'main', unique: true},
    nextAccountIndex: {type: Number, default:0,}
})

module.exports= mongoose.model('AppState', appStateSchema);