import { createDb } from "@/lib/db";
import { userRoles } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { ROLES, PERMISSIONS } from "@/lib/permissions";
import { assignRoleToUser, checkPermission, findOrCreateRole } from "@/lib/auth";

export const runtime = "edge";

export async function POST(request: Request) {
  if (!(await checkPermission(PERMISSIONS.PROMOTE_USER))) {
    return Response.json({ error: "权限不足" }, { status: 403 });
  }
  try {
    const { userId, roleName } = await request.json() as { 
      userId: string, 
      roleName: typeof ROLES.DUKE | typeof ROLES.KNIGHT | typeof ROLES.CIVILIAN 
    };
    if (!userId || !roleName) {
      return Response.json(
        { error: "缺少必要参数" },
        { status: 400 }
      );
    }

    if (![ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN].includes(roleName)) {
      return Response.json(
        { error: "角色不合法" },
        { status: 400 }
      );
    }

    const db = createDb();

    const currentUserRole = await db.query.userRoles.findFirst({
      where: eq(userRoles.userId, userId),
      with: {
        role: true,
      },
    });

    if (currentUserRole?.role.name === ROLES.EMPEROR) {
      return Response.json(
        { error: "不能降级皇帝" },
        { status: 400 }
      );
    }

    const targetRole = await findOrCreateRole(db, roleName);

    await assignRoleToUser(db, userId, targetRole.id);

    return Response.json({ 
      success: true,
    });
  } catch (error) {
    console.error("Failed to change user role:", error);
    return Response.json(
      { error: "操作失败" },
      { status: 500 }
    );
  }
}
