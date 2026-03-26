import axios from 'axios';

const api = axios.create({
  baseURL: '',
  timeout: 60000,
});

export default api;
