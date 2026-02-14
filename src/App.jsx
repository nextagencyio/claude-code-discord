import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import CourseCatalog from './pages/CourseCatalog';
import StudentDashboard from './pages/StudentDashboard';
import FacultyDirectory from './pages/FacultyDirectory';
import Navbar from './components/Navbar';

function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/courses" element={<CourseCatalog />} />
        <Route path="/dashboard" element={<StudentDashboard />} />
        <Route path="/faculty" element={<FacultyDirectory />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
