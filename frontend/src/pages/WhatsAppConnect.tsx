import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Smartphone, CheckCircle2, XCircle, LogOut } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import QRCode from "react-qr-code";

export default function WhatsAppConnect() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { token, logout } = useAuth();
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string>("not_initialized");
  const [isLoading, setIsLoading] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);

  const checkWhatsAppStatus = async () => {
    try {
      const response = await fetch('/api/whatsapp/status', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();

      if (data.authenticated) {
        // WhatsApp is connected, go to dashboard
        navigate("/");
      } else {
        setAuthStatus(data.authStatus);
        if (data.hasQR) {
          fetchQRCode();
        }
      }
    } catch (error) {
      console.error("WhatsApp status check failed:", error);
    }
  };

  const initializeWhatsApp = async () => {
    setIsInitializing(true);
    try {
      const response = await fetch('/api/whatsapp/init', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();

      if (data.success) {
        toast({
          title: "Initializing...",
          description: "WhatsApp client is starting",
        });
        setAuthStatus("initializing");
        // Start polling for QR code
        setTimeout(() => fetchQRCode(), 2000);
      }
    } catch (error) {
      console.error("WhatsApp init failed:", error);
      toast({
        title: "Error",
        description: "Failed to initialize WhatsApp",
        variant: "destructive",
      });
    } finally {
      setIsInitializing(false);
    }
  };

  const fetchQRCode = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/whatsapp/qr', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();

      if (data.authenticated) {
        navigate("/");
        return;
      }

      if (data.qr) {
        setQrCode(data.qr);
        setAuthStatus(data.authStatus);
      } else {
        setAuthStatus(data.authStatus);
      }
    } catch (error) {
      console.error("QR fetch failed:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!token) {
      navigate('/login');
      return;
    }

    // Check WhatsApp status on mount
    checkWhatsAppStatus();

    // Poll for status every 3 seconds
    const interval = setInterval(() => {
      checkWhatsAppStatus();
    }, 3000);

    return () => clearInterval(interval);
  }, [token, navigate]);

  const getStatusMessage = () => {
    switch (authStatus) {
      case "not_initialized":
        return "Click below to connect your WhatsApp";
      case "initializing":
        return "Initializing WhatsApp connection...";
      case "restoring":
        return "Restoring previous WhatsApp session...";
      case "qr_ready":
        return "Scan the QR code with WhatsApp";
      case "authenticating":
        return "Authenticating...";
      case "authenticated":
        return "Authenticated! Redirecting...";
      case "failed":
        return "Authentication failed. Please try again.";
      default:
        return "Connecting...";
    }
  };

  const getStatusIcon = () => {
    switch (authStatus) {
      case "qr_ready":
        return <Smartphone className="h-8 w-8 text-green-500" />;
      case "restoring":
      case "initializing":
        return <Loader2 className="h-8 w-8 animate-spin text-blue-500" />;
      case "authenticating":
      case "authenticated":
        return <CheckCircle2 className="h-8 w-8 text-green-500" />;
      case "failed":
        return <XCircle className="h-8 w-8 text-red-500" />;
      case "not_initialized":
        return <Smartphone className="h-8 w-8 text-gray-400" />;
      default:
        return <Loader2 className="h-8 w-8 animate-spin text-blue-500" />;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-blue-50 dark:from-gray-900 dark:to-gray-800 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-between items-center mb-4">
            <div className="flex-1" />
            <div className="flex justify-center flex-1">{getStatusIcon()}</div>
            <div className="flex-1 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={logout}
                title="Logout from account"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <CardTitle className="text-2xl">Connect WhatsApp</CardTitle>
          <CardDescription>{getStatusMessage()}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center space-y-4">
          {authStatus === "not_initialized" && (
            <Button
              onClick={initializeWhatsApp}
              disabled={isInitializing}
              className="w-full"
            >
              {isInitializing ? "Initializing..." : "Connect WhatsApp"}
            </Button>
          )}

          {isLoading && !qrCode && authStatus !== "not_initialized" && (
            <div className="flex flex-col items-center space-y-4">
              <Loader2 className="h-12 w-12 animate-spin text-gray-400" />
              <p className="text-sm text-gray-500">Generating QR code...</p>
            </div>
          )}

          {qrCode && authStatus === "qr_ready" && (
            <div className="bg-white p-6 rounded-lg shadow-inner">
              <QRCode value={qrCode} size={256} />
            </div>
          )}

          {authStatus === "authenticating" && (
            <div className="flex flex-col items-center space-y-4">
              <Loader2 className="h-12 w-12 animate-spin text-green-500" />
              <p className="text-sm text-gray-500">Verifying authentication...</p>
            </div>
          )}

          {authStatus === "authenticated" && (
            <div className="flex flex-col items-center space-y-4">
              <CheckCircle2 className="h-12 w-12 text-green-500" />
              <p className="text-sm text-gray-500">Success! Loading dashboard...</p>
            </div>
          )}

          {qrCode && (
            <div className="text-center space-y-2">
              <p className="text-xs text-gray-500">
                Open WhatsApp on your phone
              </p>
              <p className="text-xs text-gray-500">
                Go to Settings {">"} Linked Devices {">"} Link a Device
              </p>
              <p className="text-xs text-gray-500">
                Scan the QR code above
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
