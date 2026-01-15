import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { 
  Sparkles, Plus, MoreVertical, Pencil, Trash2, Package, 
  Settings2, Calculator, AlertCircle, Loader2 
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { 
  ProjectFeature, 
  FEATURE_TYPE_LABELS, 
  formatExpression,
  getExpressionColumns,
  FeatureExpression
} from "@/lib/featureEngineering";
import CreateFeatureModal from "./CreateFeatureModal";
import FeaturePackageModal from "./FeaturePackageModal";

interface FeatureEngineeringSectionProps {
  projectId: string;
  columns: { column_name: string; inferred_type: string }[];
  onFeaturesChanged?: () => void;
}

export default function FeatureEngineeringSection({
  projectId,
  columns,
  onFeaturesChanged,
}: FeatureEngineeringSectionProps) {
  const { t } = useTranslation();
  const [features, setFeatures] = useState<ProjectFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPackageModal, setShowPackageModal] = useState(false);
  const [editingFeature, setEditingFeature] = useState<ProjectFeature | null>(null);
  const [deletingFeature, setDeletingFeature] = useState<ProjectFeature | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    loadFeatures();
  }, [projectId]);

  const loadFeatures = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("project_features")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      
      // Cast expression to correct type
      const typedFeatures: ProjectFeature[] = (data || []).map(f => ({
        ...f,
        expression: f.expression as FeatureExpression
      }));
      
      setFeatures(typedFeatures);
    } catch (err) {
      console.error("Error loading features:", err);
      toast.error("Erro ao carregar features");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleFeature = async (feature: ProjectFeature) => {
    setTogglingId(feature.id);
    try {
      const { error } = await supabase
        .from("project_features")
        .update({ enabled: !feature.enabled })
        .eq("id", feature.id);

      if (error) throw error;

      setFeatures(prev =>
        prev.map(f => (f.id === feature.id ? { ...f, enabled: !f.enabled } : f))
      );
      onFeaturesChanged?.();
    } catch (err) {
      console.error("Error toggling feature:", err);
      toast.error("Erro ao alterar status da feature");
    } finally {
      setTogglingId(null);
    }
  };

  const handleDeleteFeature = async () => {
    if (!deletingFeature) return;

    try {
      const { error } = await supabase
        .from("project_features")
        .delete()
        .eq("id", deletingFeature.id);

      if (error) throw error;

      setFeatures(prev => prev.filter(f => f.id !== deletingFeature.id));
      toast.success("Feature removida com sucesso");
      onFeaturesChanged?.();
    } catch (err) {
      console.error("Error deleting feature:", err);
      toast.error("Erro ao remover feature");
    } finally {
      setDeletingFeature(null);
    }
  };

  const handleFeatureCreated = (newFeature: ProjectFeature) => {
    setFeatures(prev => [...prev, newFeature]);
    setShowCreateModal(false);
    setEditingFeature(null);
    onFeaturesChanged?.();
  };

  const handleFeatureUpdated = (updatedFeature: ProjectFeature) => {
    setFeatures(prev =>
      prev.map(f => (f.id === updatedFeature.id ? updatedFeature : f))
    );
    setEditingFeature(null);
    onFeaturesChanged?.();
  };

  const handlePackageApplied = (newFeatures: ProjectFeature[]) => {
    setFeatures(prev => [...prev, ...newFeatures]);
    setShowPackageModal(false);
    onFeaturesChanged?.();
  };

  const numericColumns = columns.filter(c => 
    c.inferred_type === "numérico" || c.inferred_type === "numerico"
  );

  return (
    <Card className="bg-gradient-card shadow-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-secondary/20 to-secondary/5 rounded-xl flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-secondary" />
            </div>
            <div>
              <CardTitle className="text-lg">Feature Engineering</CardTitle>
              <CardDescription>
                Crie transformações de dados para melhorar suas predições
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPackageModal(true)}
              disabled={numericColumns.length < 2}
            >
              <Package className="w-4 h-4 mr-2" />
              Pacotes
            </Button>
            <Button
              size="sm"
              onClick={() => setShowCreateModal(true)}
              disabled={numericColumns.length === 0}
            >
              <Plus className="w-4 h-4 mr-2" />
              Nova Feature
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : features.length === 0 ? (
          <div className="text-center py-8 space-y-4">
            <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mx-auto">
              <Calculator className="w-8 h-8 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-muted-foreground">
                Nenhuma feature criada
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                Crie features derivadas para melhorar a performance do modelo
              </p>
            </div>
            {numericColumns.length === 0 ? (
              <div className="flex items-center justify-center gap-2 text-sm text-warning">
                <AlertCircle className="w-4 h-4" />
                <span>Nenhuma coluna numérica disponível</span>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPackageModal(true)}
                >
                  <Package className="w-4 h-4 mr-2" />
                  Usar pacote pré-definido
                </Button>
                <Button size="sm" onClick={() => setShowCreateModal(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Criar manualmente
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Expressão</TableHead>
                  <TableHead className="text-center">Ativa</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {features.map((feature) => (
                  <TableRow key={feature.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{feature.label}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {feature.name}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {FEATURE_TYPE_LABELS[feature.expression?.type] || "Desconhecido"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-2 py-1 rounded">
                        {formatExpression(feature.expression)}
                      </code>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={feature.enabled}
                        onCheckedChange={() => handleToggleFeature(feature)}
                        disabled={togglingId === feature.id}
                      />
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => setEditingFeature(feature)}
                          >
                            <Pencil className="w-4 h-4 mr-2" />
                            Editar
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeletingFeature(feature)}
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            Remover
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {features.length > 0 && (
          <p className="text-xs text-muted-foreground mt-4">
            <Settings2 className="w-3 h-3 inline mr-1" />
            Ao recalcular a EDA, as features ativas serão incluídas nas estatísticas.
          </p>
        )}
      </CardContent>

      {/* Create/Edit Feature Modal */}
      {(showCreateModal || editingFeature) && (
        <CreateFeatureModal
          open={showCreateModal || !!editingFeature}
          onOpenChange={(open) => {
            if (!open) {
              setShowCreateModal(false);
              setEditingFeature(null);
            }
          }}
          projectId={projectId}
          columns={numericColumns}
          editingFeature={editingFeature}
          onFeatureCreated={handleFeatureCreated}
          onFeatureUpdated={handleFeatureUpdated}
        />
      )}

      {/* Feature Package Modal */}
      {showPackageModal && (
        <FeaturePackageModal
          open={showPackageModal}
          onOpenChange={setShowPackageModal}
          projectId={projectId}
          columns={numericColumns}
          existingFeatureNames={features.map(f => f.name)}
          onPackageApplied={handlePackageApplied}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingFeature} onOpenChange={() => setDeletingFeature(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover feature</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja remover a feature "{deletingFeature?.label}"?
              Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteFeature}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
