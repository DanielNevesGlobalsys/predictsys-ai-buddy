import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FileText, Download, Loader2 } from 'lucide-react';
import { generateTechnicalReportPDF } from '@/lib/generateTechnicalReportPDF';
import { toast } from 'sonner';

interface ExportTechnicalReportButtonProps {
  variant?: 'default' | 'outline' | 'secondary';
  size?: 'default' | 'sm' | 'lg';
  className?: string;
}

export const ExportTechnicalReportButton: React.FC<ExportTechnicalReportButtonProps> = ({
  variant = 'default',
  size = 'default',
  className = '',
}) => {
  const [isGenerating, setIsGenerating] = useState(false);

  const handleExport = async () => {
    setIsGenerating(true);
    
    try {
      // Small delay to show loading state
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const filename = generateTechnicalReportPDF({ language: 'pt' });
      
      toast.success('Relatório técnico exportado!', {
        description: `Arquivo salvo como ${filename}`,
      });
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast.error('Erro ao gerar PDF', {
        description: 'Tente novamente em alguns segundos.',
      });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleExport}
      disabled={isGenerating}
      className={className}
    >
      {isGenerating ? (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Gerando PDF...
        </>
      ) : (
        <>
          <FileText className="h-4 w-4 mr-2" />
          Relatório Técnico (PDF)
        </>
      )}
    </Button>
  );
};
