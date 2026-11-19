import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/auth/AuthContext";
import { ProtectedRoute } from "@/auth/ProtectedRoute";
import { AppLayout } from "@/components/AppLayout";
import { EmergencyPage } from "@/pages/EmergencyPage";
import { AvailabilityPage } from "@/pages/AvailabilityPage";
import { MediaPage } from "@/pages/MediaPage";
import { NewsPage } from "@/pages/NewsPage";
import { ScreensPage } from "@/pages/ScreensPage";
import { ReservationsPage } from "@/pages/ReservationsPage";
import { SecurityPage } from "@/pages/SecurityPage";
import { SectionPage } from "@/pages/SectionPage";
import { SchedulesPage } from "@/pages/SchedulesPage";
import { TemplatesPage } from "@/pages/TemplatesPage";
import { AnnouncementsPage } from "@/pages/AnnouncementsPage";
import { BuildingsPage } from "@/pages/BuildingsPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { DeviceDetailPage } from "@/pages/DeviceDetailPage";
import { DevicesPage } from "@/pages/DevicesPage";
import { ForgotPasswordPage } from "@/pages/ForgotPasswordPage";
import { ImportPage } from "@/pages/ImportPage";
import { IntercomPage } from "@/pages/IntercomPage";
import { LoginPage } from "@/pages/LoginPage";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { RoomsPage } from "@/pages/RoomsPage";
import { StudentsPage } from "@/pages/StudentsPage";
import { StatusesPage } from "@/pages/StatusesPage";
import { StaffPage } from "@/pages/StaffPage";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<AppLayout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/security" element={<SecurityPage />} />
              <Route path="/section/:id" element={<SectionPage />} />
              <Route path="/rooms" element={<RoomsPage />} />
              <Route path="/buildings" element={<BuildingsPage />} />
              <Route path="/reservations" element={<ReservationsPage />} />
              <Route path="/availability" element={<AvailabilityPage />} />
              <Route element={<ProtectedRoute roles={["admin", "operator"]} />}>
                <Route path="/devices" element={<DevicesPage />} />
                <Route path="/devices/:id" element={<DeviceDetailPage />} />
                <Route path="/emergency" element={<EmergencyPage />} />
                <Route path="/announcements" element={<AnnouncementsPage />} />
                <Route path="/intercom" element={<IntercomPage />} />
                <Route path="/schedules" element={<SchedulesPage />} />
                <Route path="/templates" element={<TemplatesPage />} />
                <Route path="/media" element={<MediaPage />} />
                <Route path="/screens" element={<ScreensPage />} />
                <Route path="/news" element={<NewsPage />} />
                <Route path="/statuses" element={<StatusesPage />} />
                <Route path="/staff" element={<StaffPage />} />
                <Route path="/students" element={<StudentsPage />} />
                <Route path="/import" element={<ImportPage />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
