import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Download, Loader2 } from "lucide-react";
import { jsPDF } from "jspdf";
import { useToast } from "@/hooks/use-toast";

interface Message {
  id?: string;
  sender_type: "user" | "assistant";
  message_text: string;
  created_at: string;
}

interface ExportChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: Message[];
  projectName: string;
  allMessages?: Message[];
}

const ExportChatDialog = ({
  open,
  onOpenChange,
  messages,
  projectName,
  allMessages,
}: ExportChatDialogProps) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [exportType, setExportType] = useState<"complete" | "current">("current");
  const [isExporting, setIsExporting] = useState(false);

  const generatePDF = async () => {
    setIsExporting(true);
    
    try {
      const messagesToExport = exportType === "complete" && allMessages 
        ? allMessages 
        : messages;

      if (messagesToExport.length === 0) {
        toast({
          title: t("common.error"),
          description: t("chat.noMessages"),
          variant: "destructive",
        });
        return;
      }

      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 20;
      const maxWidth = pageWidth - margin * 2;
      let yPosition = 20;

      // Header
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("PredictSys AI - Chat Export", margin, yPosition);
      yPosition += 10;

      doc.setFontSize(12);
      doc.setFont("helvetica", "normal");
      doc.text(`Project: ${projectName}`, margin, yPosition);
      yPosition += 7;

      const exportDate = new Date().toLocaleString();
      doc.text(`Export date: ${exportDate}`, margin, yPosition);
      yPosition += 7;

      doc.text(`Messages: ${messagesToExport.length}`, margin, yPosition);
      yPosition += 15;

      // Separator line
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, yPosition, pageWidth - margin, yPosition);
      yPosition += 10;

      // Messages
      for (const message of messagesToExport) {
        const sender = message.sender_type === "user" ? "User" : "AI Assistant";
        const timestamp = new Date(message.created_at).toLocaleString();

        // Check if we need a new page
        if (yPosition > 270) {
          doc.addPage();
          yPosition = 20;
        }

        // Sender header
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(message.sender_type === "user" ? 0 : 59, 130, 246);
        doc.text(`${sender} - ${timestamp}`, margin, yPosition);
        yPosition += 6;

        // Message text
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(60, 60, 60);

        const lines = doc.splitTextToSize(message.message_text, maxWidth);
        
        for (const line of lines) {
          if (yPosition > 280) {
            doc.addPage();
            yPosition = 20;
          }
          doc.text(line, margin, yPosition);
          yPosition += 5;
        }

        yPosition += 8;
      }

      // Generate filename
      const sanitizedName = projectName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
      const dateStr = new Date().toISOString().split("T")[0];
      const filename = `chat_predictsys_${sanitizedName}_${dateStr}.pdf`;

      doc.save(filename);

      toast({
        title: t("common.success"),
        description: t("chat.exportSuccess"),
      });

      onOpenChange(false);
    } catch (error) {
      console.error("Error exporting PDF:", error);
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : "Export failed",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="w-5 h-5" />
            {t("chat.exportTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("chat.exportDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <RadioGroup
            value={exportType}
            onValueChange={(value) => setExportType(value as "complete" | "current")}
            className="space-y-3"
          >
            <div className="flex items-center space-x-3">
              <RadioGroupItem value="complete" id="complete" />
              <Label htmlFor="complete" className="cursor-pointer">
                {t("chat.exportComplete")}
              </Label>
            </div>
            <div className="flex items-center space-x-3">
              <RadioGroupItem value="current" id="current" />
              <Label htmlFor="current" className="cursor-pointer">
                {t("chat.exportCurrent")}
              </Label>
            </div>
          </RadioGroup>
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={generatePDF} disabled={isExporting}>
            {isExporting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t("common.loading")}
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                {t("chat.exportPdf")}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ExportChatDialog;
