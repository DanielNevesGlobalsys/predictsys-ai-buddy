import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  ProjectFeature,
  FeatureExpression,
  FEATURE_TYPE_LABELS,
  FEATURE_TYPE_DESCRIPTIONS,
  BINARY_FLAG_OPERATORS,
  slugify,
  validateExpression,
} from "@/lib/featureEngineering";

interface CreateFeatureModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  columns: { column_name: string; inferred_type: string }[];
  editingFeature: ProjectFeature | null;
  onFeatureCreated: (feature: ProjectFeature) => void;
  onFeatureUpdated: (feature: ProjectFeature) => void;
}

type FeatureType = FeatureExpression["type"];

export default function CreateFeatureModal({
  open,
  onOpenChange,
  projectId,
  columns,
  editingFeature,
  onFeatureCreated,
  onFeatureUpdated,
}: CreateFeatureModalProps) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [featureType, setFeatureType] = useState<FeatureType>("ratio");

  // Expression fields
  const [numerator, setNumerator] = useState("");
  const [denominator, setDenominator] = useState("");
  const [minuend, setMinuend] = useState("");
  const [subtrahend, setSubtrahend] = useState("");
  const [sumColumns, setSumColumns] = useState<string[]>([]);
  const [binaryColumn, setBinaryColumn] = useState("");
  const [binaryOp, setBinaryOp] = useState<">" | ">=" | "<" | "<=" | "==" | "!=">(">");
  const [binaryValue, setBinaryValue] = useState<number>(0);
  const [log1pColumn, setLog1pColumn] = useState("");

  useEffect(() => {
    if (editingFeature) {
      setName(editingFeature.name);
      setLabel(editingFeature.label);
      setDescription(editingFeature.description || "");
      setFeatureType(editingFeature.expression.type);

      const expr = editingFeature.expression;
      switch (expr.type) {
        case "ratio":
          setNumerator(expr.numerator);
          setDenominator(expr.denominator);
          break;
        case "difference":
          setMinuend(expr.minuend);
          setSubtrahend(expr.subtrahend);
          break;
        case "sum":
          setSumColumns(expr.columns);
          break;
        case "binary_flag":
          setBinaryColumn(expr.column);
          setBinaryOp(expr.op);
          setBinaryValue(expr.value);
          break;
        case "log1p":
          setLog1pColumn(expr.column);
          break;
      }
    } else {
      resetForm();
    }
  }, [editingFeature]);

  const resetForm = () => {
    setName("");
    setLabel("");
    setDescription("");
    setFeatureType("ratio");
    setNumerator("");
    setDenominator("");
    setMinuend("");
    setSubtrahend("");
    setSumColumns([]);
    setBinaryColumn("");
    setBinaryOp(">");
    setBinaryValue(0);
    setLog1pColumn("");
    setError(null);
  };

  const buildExpression = (): FeatureExpression | null => {
    switch (featureType) {
      case "ratio":
        return { type: "ratio", numerator, denominator, eps: 1e-6 };
      case "difference":
        return { type: "difference", minuend, subtrahend };
      case "sum":
        return { type: "sum", columns: sumColumns };
      case "binary_flag":
        return { type: "binary_flag", column: binaryColumn, op: binaryOp, value: binaryValue };
      case "log1p":
        return { type: "log1p", column: log1pColumn };
      default:
        return null;
    }
  };

  const handleSave = async () => {
    setError(null);

    // Validate basic fields
    if (!label.trim()) {
      setError("Informe o nome da feature");
      return;
    }

    // Generate name from label if not editing
    const finalName = editingFeature ? name : slugify(label);
    if (!finalName) {
      setError("Não foi possível gerar um nome válido");
      return;
    }

    // Build and validate expression
    const expression = buildExpression();
    if (!expression) {
      setError("Expressão inválida");
      return;
    }

    const validationError = validateExpression(expression);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);

    try {
      if (editingFeature) {
        // Update existing feature
        const { data, error: updateError } = await supabase
          .from("project_features")
          .update({
            label: label.trim(),
            description: description.trim() || null,
            expression,
          })
          .eq("id", editingFeature.id)
          .select()
          .single();

        if (updateError) throw updateError;

        toast.success("Feature atualizada com sucesso");
        onFeatureUpdated({
          ...data,
          expression: data.expression as FeatureExpression,
        });
      } else {
        // Create new feature
        const { data, error: insertError } = await supabase
          .from("project_features")
          .insert({
            project_id: projectId,
            name: finalName,
            label: label.trim(),
            description: description.trim() || null,
            expression,
            enabled: true,
          })
          .select()
          .single();

        if (insertError) {
          if (insertError.code === "23505") {
            setError("Já existe uma feature com este nome");
            return;
          }
          throw insertError;
        }

        toast.success("Feature criada com sucesso");
        onFeatureCreated({
          ...data,
          expression: data.expression as FeatureExpression,
        });
        resetForm();
      }
    } catch (err) {
      console.error("Error saving feature:", err);
      setError("Erro ao salvar feature. Tente novamente.");
    } finally {
      setSaving(false);
    }
  };

  const columnOptions = columns.map((c) => c.column_name);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editingFeature ? "Editar Feature" : "Criar Nova Feature"}
          </DialogTitle>
          <DialogDescription>
            Configure uma transformação para criar uma nova coluna derivada
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Label */}
          <div className="space-y-2">
            <Label htmlFor="label">Nome da Feature *</Label>
            <Input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ex: Ticket médio por compra"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Descrição (opcional)</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Explique o que esta feature representa"
              rows={2}
            />
          </div>

          {/* Feature Type */}
          <div className="space-y-2">
            <Label>Tipo de Transformação *</Label>
            <Select
              value={featureType}
              onValueChange={(val) => setFeatureType(val as FeatureType)}
              disabled={!!editingFeature}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(FEATURE_TYPE_LABELS) as [FeatureType, string][]).map(
                  ([type, label]) => (
                    <SelectItem key={type} value={type}>
                      {label}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {FEATURE_TYPE_DESCRIPTIONS[featureType]}
            </p>
          </div>

          {/* Dynamic fields based on type */}
          {featureType === "ratio" && (
            <>
              <div className="space-y-2">
                <Label>Numerador (coluna A)</Label>
                <Select value={numerator} onValueChange={setNumerator}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione a coluna" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Denominador (coluna B)</Label>
                <Select value={denominator} onValueChange={setDenominator}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione a coluna" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground flex items-start gap-1">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                Resultado: A / B (divisão por zero retorna 0)
              </p>
            </>
          )}

          {featureType === "difference" && (
            <>
              <div className="space-y-2">
                <Label>Primeira coluna (minuendo)</Label>
                <Select value={minuend} onValueChange={setMinuend}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione a coluna" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Segunda coluna (subtraendo)</Label>
                <Select value={subtrahend} onValueChange={setSubtrahend}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione a coluna" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground flex items-start gap-1">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                Resultado: A - B
              </p>
            </>
          )}

          {featureType === "sum" && (
            <>
              <div className="space-y-2">
                <Label>Colunas para somar (selecione múltiplas)</Label>
                <div className="flex flex-wrap gap-2 p-3 border rounded-md min-h-[60px]">
                  {columnOptions.map((col) => (
                    <Button
                      key={col}
                      variant={sumColumns.includes(col) ? "default" : "outline"}
                      size="sm"
                      onClick={() => {
                        if (sumColumns.includes(col)) {
                          setSumColumns(sumColumns.filter((c) => c !== col));
                        } else {
                          setSumColumns([...sumColumns, col]);
                        }
                      }}
                    >
                      {col}
                    </Button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground flex items-start gap-1">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                Resultado: soma de todas as colunas selecionadas
              </p>
            </>
          )}

          {featureType === "binary_flag" && (
            <>
              <div className="space-y-2">
                <Label>Coluna</Label>
                <Select value={binaryColumn} onValueChange={setBinaryColumn}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione a coluna" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Operador</Label>
                  <Select value={binaryOp} onValueChange={(val) => setBinaryOp(val as typeof binaryOp)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BINARY_FLAG_OPERATORS.map((op) => (
                        <SelectItem key={op.value} value={op.value}>
                          {op.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Valor</Label>
                  <Input
                    type="number"
                    value={binaryValue}
                    onChange={(e) => setBinaryValue(parseFloat(e.target.value) || 0)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground flex items-start gap-1">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                Resultado: 1 se a condição for verdadeira, 0 caso contrário
              </p>
            </>
          )}

          {featureType === "log1p" && (
            <>
              <div className="space-y-2">
                <Label>Coluna</Label>
                <Select value={log1pColumn} onValueChange={setLog1pColumn}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione a coluna" />
                  </SelectTrigger>
                  <SelectContent>
                    {columnOptions.map((col) => (
                      <SelectItem key={col} value={col}>
                        {col}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground flex items-start gap-1">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                Resultado: log(1 + x) — útil para suavizar distribuições com valores extremos
              </p>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {editingFeature ? "Salvar alterações" : "Criar Feature"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
