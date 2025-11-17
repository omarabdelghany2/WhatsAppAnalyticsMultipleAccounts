import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, wsClient } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Smartphone, CheckCircle2, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import QRCode from "react-qr-code";

export default function Login() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string>("initializing");
  const [isLoading, setIsLoading] = useState(true);

  const checkAuth = async () => {
    try {
      const response = await api.getAuthStatus();
      if (response.authenticated) {
        navigate("/");
      } else {
        setAuthStatus(response.authStatus);
      }
    } catch (error) {
      console.error("Auth check failed:", error);
    }
  };

  const fetchQRCode = async () => {
    try {
      const response = await api.getQRCode();

      if (response.authenticated) {
        navigate("/");
        return;
      }

      if (response.qr) {
        setQrCode(response.qr);
        setAuthStatus(response.authStatus);
        setIsLoading(false);
      } else {
        setAuthStatus(response.authStatus);
        setIsLoading(true);
      }
    } catch (error) {
      console.error("QR fetch failed:", error);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Check auth status on mount
    checkAuth();
    fetchQRCode();

    // Poll for both QR code and auth status every 2 seconds
    const qrInterval = setInterval(() => {
      checkAuth();
      if (!qrCode || authStatus === "initializing") {
        fetchQRCode();
      }
    }, 2000);

    // Connect to WebSocket for real-time updates
    wsClient.connect();

    const handleQR = (data: any) => {
      if (data.qr) {
        setQrCode(data.qr);
        setAuthStatus("qr_ready");
        setIsLoading(false);
        toast({
          title: "QR Code Ready",
          description: "Scan the QR code with your WhatsApp",
        });
      }
    };

    const handleAuthenticated = () => {
      setAuthStatus("authenticating");
      toast({
        title: "Authenticated!",
        description: "WhatsApp authenticated successfully",
      });
    };

    const handleReady = () => {
      toast({
        title: "Connected!",
        description: "Redirecting to dashboard...",
      });
      setTimeout(() => navigate("/"), 1000);
    };

    const handleAuthFailure = (data: any) => {
      setAuthStatus("failed");
      toast({
        title: "Authentication Failed",
        description: data.message || "Please try again",
        variant: "destructive",
      });
    };

    wsClient.on("qr", handleQR);
    wsClient.on("authenticated", handleAuthenticated);
    wsClient.on("ready", handleReady);
    wsClient.on("auth_failure", handleAuthFailure);

    return () => {
      clearInterval(qrInterval);
      wsClient.off("qr", handleQR);
      wsClient.off("authenticated", handleAuthenticated);
      wsClient.off("ready", handleReady);
      wsClient.off("auth_failure", handleAuthFailure);
    };
  }, [navigate, toast, qrCode, authStatus]);

  const getStatusMessage = () => {
    switch (authStatus) {
      case "initializing":
        return "Initializing WhatsApp connection...";
      case "qr_ready":
        return "Scan the QR code with WhatsApp";
      case "authenticating":
        return "Authenticating...";
      case "authenticated":
        return "Authenticated! Redirecting...";
      case "failed":
        return "Authentication failed. Please refresh and try again.";
      default:
        return "Connecting...";
    }
  };

  const getStatusIcon = () => {
    switch (authStatus) {
      case "qr_ready":
        return <Smartphone className="h-8 w-8 text-green-500" />;
      case "authenticating":
      case "authenticated":
        return <CheckCircle2 className="h-8 w-8 text-green-500" />;
      case "failed":
        return <XCircle className="h-8 w-8 text-red-500" />;
      default:
        return <Loader2 className="h-8 w-8 animate-spin text-blue-500" />;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-blue-50 dark:from-gray-900 dark:to-gray-800 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">{getStatusIcon()}</div>
          <CardTitle className="text-2xl">WhatsApp Analytics</CardTitle>
          <CardDescription>{getStatusMessage()}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center space-y-4">
          {isLoading && !qrCode && (
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
        </CardContent>
      </Card>
    </div>
  );
}
