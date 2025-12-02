import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileSpreadsheet, CheckCircle, Info } from "lucide-react";
import type { ProjectData } from "../WizardContainer";

interface StepDataUploadProps {
  projectData: ProjectData;
  onNext: (data?: Partial<ProjectData>) => void;
  onBack: () => void;
  loading: boolean;
}

const StepDataUpload = ({ projectData, onNext, onBack, loading }: StepDataUploadProps) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".csv")) {
      setSelectedFile(file);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
    }
  };

  return (
    <Card className="bg-gradient-card shadow-card p-8">
      <div className="space-y-6">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Upload className="w-8 h-8 text-primary-foreground" />
          </div>
          <h2 className="text-2xl font-display font-bold mb-2">
            Upload dos Dados
          </h2>
          <p className="text-muted-foreground">
            Envie um arquivo CSV com os dados que serão usados para treinar o modelo
          </p>
        </div>

        {/* Info box */}
        <div className="flex items-start gap-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
          <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-primary mb-1">Requisitos do arquivo:</p>
            <ul className="text-muted-foreground space-y-1">
              <li>• Formato CSV (valores separados por vírgula)</li>
              <li>• Tamanho máximo: 50 MB</li>
              <li>• Codificação UTF-8</li>
              <li>• Primeira linha deve conter os nomes das colunas</li>
            </ul>
          </div>
        </div>

        {/* Upload area */}
        <div
          className={`relative border-2 border-dashed rounded-xl p-12 text-center transition-all ${
            isDragging
              ? "border-primary bg-primary/5"
              : selectedFile
              ? "border-accent bg-accent/5"
              : "border-border hover:border-primary/50 hover:bg-muted/50"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            type="file"
            accept=".csv"
            onChange={handleFileSelect}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />

          {selectedFile ? (
            <div className="space-y-4">
              <div className="w-16 h-16 bg-accent/20 rounded-2xl flex items-center justify-center mx-auto">
                <CheckCircle className="w-8 h-8 text-accent" />
              </div>
              <div>
                <p className="font-semibold text-lg">{selectedFile.name}</p>
                <p className="text-sm text-muted-foreground">
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedFile(null);
                }}
              >
                Trocar arquivo
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mx-auto">
                <FileSpreadsheet className="w-8 h-8 text-muted-foreground" />
              </div>
              <div>
                <p className="font-semibold text-lg">
                  Arraste e solte seu arquivo CSV aqui
                </p>
                <p className="text-muted-foreground">
                  ou clique para selecionar
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Preview placeholder */}
        {selectedFile && (
          <div className="space-y-3">
            <h3 className="font-semibold">Pré-visualização dos dados</h3>
            <div className="bg-muted/50 rounded-lg p-8 text-center">
              <FileSpreadsheet className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">
                A pré-visualização será carregada após o processamento do arquivo.
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                (Funcionalidade será implementada em breve)
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-6 border-t border-border">
          <Button variant="outline" onClick={onBack} disabled={loading}>
            Voltar
          </Button>
          <Button
            onClick={() => onNext()}
            disabled={loading}
            className="bg-gradient-primary hover:shadow-hover transition-all"
          >
            Próximo
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default StepDataUpload;
